const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  getAggregateVotesInPollMessage
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { formatMessage } = require('./messageTemplates');
const { storePollOptions, getPollOptions, handlePollVote } = require('./orderManager');

let sock = null, qrImg = null, status = 'disconnected';
let qrShownOnce = false;   // for clearSignalKeys — only clear once per login cycle
let authState = null;       // store auth state for poll decryption

// ── In-memory poll message store (for PATH 1 decryption) ──
const sentPolls = new Map(); // pollMsgId → { jid, msg (full WAMessage) }

// ── Message queue for when WA is reconnecting ──
const messageQueue = [];

// ── POLL OPTIONS (must match EXACTLY what WhatFlow uses) ──
const POLL_OPTIONS = [
  'Confirm ✅ (Cash On Delivery)',
  'Confirm ✅ Advance Payment  (EXTRA 150/- Discount)',  // two spaces before EXTRA
  'Cancel Order'
];

// ══════════════════════════════════════════════════════════
// FIX #5: Clear stale Signal keys on new QR login
// Prevents "Bad MAC" decryption errors after redeploy
// ══════════════════════════════════════════════════════════
function clearSignalKeys() {
  const sessionDir = process.env.SESSION_DIR || './wa_session';
  if (!fs.existsSync(sessionDir)) return;

  const patterns = [
    /^session-/,
    /^pre-key-/,
    /^sender-key-/,
    /^app-state-sync-/,
    /^app-state-version-/,
    /^sender-key-memory\.json$/
  ];

  let cleared = 0;
  const files = fs.readdirSync(sessionDir);
  for (const file of files) {
    if (patterns.some(p => p.test(file))) {
      try {
        fs.unlinkSync(path.join(sessionDir, file));
        cleared++;
      } catch (e) { /* ignore */ }
    }
  }
  if (cleared > 0) {
    console.log(`[SIGNAL] Cleared ${cleared} stale signal key files`);
  }
}

// ══════════════════════════════════════════════════════════
// FIX #1: waitForConnection — replaces ensureConn()
// Waits up to maxWaitMs for WA to reconnect (for Render cold starts)
// ══════════════════════════════════════════════════════════
function waitForConnection(maxWaitMs = 120000) {
  return new Promise((resolve, reject) => {
    if (status === 'connected') return resolve();
    console.log(`[WAIT] WhatsApp not connected, waiting up to ${maxWaitMs / 1000}s...`);
    const start = Date.now();
    const interval = setInterval(() => {
      if (status === 'connected') {
        clearInterval(interval);
        console.log(`[WAIT] Connected after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        resolve();
      } else if (Date.now() - start > maxWaitMs) {
        clearInterval(interval);
        reject(new Error('WhatsApp connection timeout'));
      }
    }, 3000);
  });
}

// ── Safe send with wait ──
async function safeSend(jid, content) {
  await waitForConnection();
  return sock.sendMessage(jid, content);
}

// ── Process queued messages after reconnect ──
async function processQueue() {
  while (messageQueue.length > 0) {
    const { fn, args } = messageQueue.shift();
    try {
      await fn(...args);
    } catch (e) {
      console.error('[QUEUE] Failed to process queued message:', e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════
// Main WhatsApp connection
// ══════════════════════════════════════════════════════════
async function getWASocket() {
  const sessionDir = process.env.SESSION_DIR || './wa_session';
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  authState = state;  // store for poll decryption
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: true,
    browser: ['WA-Shopify-Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Connection events ──
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // FIX #5: Clear signal keys on FIRST QR of this login cycle
      if (!qrShownOnce) {
        clearSignalKeys();
        qrShownOnce = true;
      }
      qrImg = await QRCode.toDataURL(qr);
      status = 'qr_ready';
      console.log('[QR] QR code ready at /qr');
    }

    if (connection === 'open') {
      status = 'connected';
      qrImg = null;
      qrShownOnce = false; // reset for next login cycle
      console.log('[WA] WhatsApp Connected!');
      // Process any queued messages
      processQueue();
    }

    if (connection === 'close') {
      status = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[WA] Disconnected. Code: ${code}`);
      if (code !== DisconnectReason.loggedOut) {
        console.log('[WA] Reconnecting in 5s...');
        setTimeout(getWASocket, 5000);
      } else {
        console.log('[WA] Logged out. Need fresh QR scan.');
        qrShownOnce = false; // allow signal key clearing on next QR
      }
    }
  });

  // ══════════════════════════════════════════════════════════
  // FIX #3 + #4: Poll vote handler using messages.update
  // PATH 1: getAggregateVotesInPollMessage (same instance, full msg available)
  // PATH 2: SHA-256 hash matching (after redeploy, disk-persisted options)
  // ══════════════════════════════════════════════════════════
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      const pollUpdates = update?.pollUpdates;
      if (!pollUpdates || pollUpdates.length === 0) continue;

      const pollMsgId = key.id;
      console.log(`[POLL] Vote received for poll msg: ${pollMsgId}`);

      let votedOption = null;
      let voterJid = null;

      // ── PATH 1: In-memory full message decryption ──
      const pollData = sentPolls.get(pollMsgId);
      if (pollData && pollData.msg) {
        console.log('[POLL] PATH 1: Using in-memory poll message for decryption');
        try {
          const votes = getAggregateVotesInPollMessage({
            message: pollData.msg.message,
            key: pollData.msg.key,
            pollUpdates
          }, authState.creds.me);

          if (votes && votes.length > 0) {
            for (const v of votes) {
              if (v.voters && v.voters.length > 0) {
                votedOption = v.name;
                break;
              }
            }
          }
          voterJid = pollData.jid; // use stored JID (bypasses @lid issue)
          if (votedOption) {
            console.log(`[POLL] PATH 1 success: "${votedOption}" from ${voterJid}`);
          }
        } catch (e) {
          console.error('[POLL] PATH 1 decryption failed:', e.message);
        }
      }

      // ── PATH 2: Fallback to SHA-256 hash matching from disk ──
      if (!votedOption) {
        const diskData = getPollOptions(pollMsgId);
        if (diskData) {
          console.log('[POLL] PATH 2: Using disk-persisted poll options for hash matching');
          voterJid = diskData.jid;

          for (const pu of pollUpdates) {
            const hashes = pu.vote?.selectedOptions;
            if (!hashes || hashes.length === 0) continue;

            for (const hash of hashes) {
              // hash is a Buffer — compare against SHA-256 of each option name
              for (const optionName of diskData.options) {
                const expectedHash = crypto.createHash('sha256').update(optionName).digest();
                if (Buffer.isBuffer(hash) && hash.equals(expectedHash)) {
                  votedOption = optionName;
                  break;
                }
                // Also try comparing as Uint8Array
                if (hash instanceof Uint8Array && Buffer.from(hash).equals(expectedHash)) {
                  votedOption = optionName;
                  break;
                }
              }
              if (votedOption) break;
            }
            if (votedOption) break;
          }

          if (votedOption) {
            console.log(`[POLL] PATH 2 success: "${votedOption}" from ${voterJid}`);
          } else {
            console.log('[POLL] PATH 2: Could not match any hash to stored options');
            // Debug: log the hashes for troubleshooting
            for (const pu of pollUpdates) {
              const hashes = pu.vote?.selectedOptions || [];
              console.log(`[POLL-DEBUG] Received ${hashes.length} hash(es)`);
              for (const h of hashes) {
                const buf = Buffer.isBuffer(h) ? h : Buffer.from(h);
                console.log(`[POLL-DEBUG] Hash: ${buf.toString('hex').slice(0, 16)}...`);
              }
            }
            for (const optName of (diskData.options || [])) {
              const expected = crypto.createHash('sha256').update(optName).digest();
              console.log(`[POLL-DEBUG] Expected for "${optName}": ${expected.toString('hex').slice(0, 16)}...`);
            }
          }
        } else {
          console.log(`[POLL] No stored poll data found for msg ID: ${pollMsgId} (neither in-memory nor disk)`);
        }
      }

      // ── Process the vote ──
      if (votedOption && voterJid) {
        await handlePollVote(voterJid, votedOption, sock);
        // Cleanup
        sentPolls.delete(pollMsgId);
      }
    }
  });

  return sock;
}

// ══════════════════════════════════════════════════════════
// Phone number → WhatsApp JID
// ══════════════════════════════════════════════════════════
function toJid(phone) {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
  if (n.startsWith('3') && n.length === 10) n = '92' + n;
  return n + '@s.whatsapp.net';
}

// ══════════════════════════════════════════════════════════
// Send order confirmation + poll
// ══════════════════════════════════════════════════════════
async function sendOrderConfirmation(phone, order) {
  const jid = toJid(phone);

  // Send text message
  await safeSend(jid, { text: formatMessage('orderConfirmation', order) });

  // Send poll
  const pollResult = await safeSend(jid, {
    poll: {
      name: 'Please confirm your order:',
      values: POLL_OPTIONS,
      selectableCount: 1
    }
  });

  // Store poll for vote handling
  if (pollResult && pollResult.key) {
    const pollMsgId = pollResult.key.id;

    // PATH 1: Store full message in memory (for same-instance decryption)
    sentPolls.set(pollMsgId, {
      jid,
      msg: pollResult  // full WAMessage object needed by getAggregateVotesInPollMessage
    });

    // PATH 2: Store options to disk (for post-redeploy hash matching)
    storePollOptions(pollMsgId, jid, POLL_OPTIONS);

    console.log(`[POLL] Stored poll ${pollMsgId} for ${jid} (memory + disk)`);
  }

  console.log(`[SEND] Confirmation + poll sent to ${phone}`);
}

// ══════════════════════════════════════════════════════════
// Other send functions
// ══════════════════════════════════════════════════════════
async function sendAbandonedCheckout(phone, checkout) {
  await safeSend(toJid(phone), { text: formatMessage('abandonedCheckout', checkout) });
  console.log(`[SEND] Abandoned cart sent to ${phone}`);
}

async function sendAdminNotification(phone, order) {
  await safeSend(toJid(phone), { text: formatMessage('adminNotification', order) });
  console.log(`[SEND] Admin notification sent to ${phone}`);
}

async function sendFulfillmentNotification(phone, order) {
  await safeSend(toJid(phone), { text: formatMessage('fulfillment', order) });
  console.log(`[SEND] Fulfillment sent to ${phone}`);
}

module.exports = {
  getWASocket,
  sendOrderConfirmation,
  sendAbandonedCheckout,
  sendAdminNotification,
  sendFulfillmentNotification,
  getQRImage: () => qrImg,
  getConnectionStatus: () => status
};
