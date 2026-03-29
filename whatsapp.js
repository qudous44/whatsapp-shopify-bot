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
let qrShownOnce = false;
let authState = null;

const sentPolls = new Map();
const messageQueue = [];
const processedPollVotes = new Set();

const POLL_OPTIONS = [
  'Confirm ✅ (Cash On Delivery)',
  'Confirm ✅ Advance Payment  (EXTRA 150/- Discount)',
  'Cancel Order'
];

function clearSignalKeys() {
  const sessionDir = process.env.SESSION_DIR || './wa_session';
  if (!fs.existsSync(sessionDir)) return;
  const patterns = [
    /^session-/, /^pre-key-/, /^sender-key-/,
    /^app-state-sync-/, /^app-state-version-/, /^sender-key-memory\.json$/
  ];
  let cleared = 0;
  for (const file of fs.readdirSync(sessionDir)) {
    if (patterns.some(p => p.test(file))) {
      try { fs.unlinkSync(path.join(sessionDir, file)); cleared++; } catch (e) {}
    }
  }
  if (cleared > 0) console.log(`[SIGNAL] Cleared ${cleared} stale signal key files`);
}

function waitForConnection(maxWaitMs = 120000) {
  return new Promise((resolve, reject) => {
    if (status === 'connected') return resolve();
    console.log(`[WAIT] WhatsApp not connected, waiting up to ${maxWaitMs / 1000}s...`);
    const start = Date.now();
    const interval = setInterval(() => {
      if (status === 'connected') { clearInterval(interval); resolve(); }
      else if (Date.now() - start > maxWaitMs) { clearInterval(interval); reject(new Error('WhatsApp connection timeout')); }
    }, 3000);
  });
}

async function safeSend(jid, content) {
  await waitForConnection();
  return sock.sendMessage(jid, content);
}

async function processQueue() {
  while (messageQueue.length > 0) {
    const { fn, args } = messageQueue.shift();
    try { await fn(...args); } catch (e) { console.error('[QUEUE] Error:', e.message); }
  }
}

async function processPollVote(pollMsgId, pollUpdates, source) {
  if (processedPollVotes.has(pollMsgId)) {
    console.log(`[POLL] Already processed ${pollMsgId}, skipping`);
    return;
  }
  console.log(`[POLL] Processing vote for pollMsgId: ${pollMsgId} via ${source}`);

  let votedOption = null;
  let voterJid = null;

  // PATH 1: in-memory (same instance)
  const pollData = sentPolls.get(pollMsgId);
  if (pollData && pollData.msg && authState) {
    console.log('[POLL] PATH 1: in-memory decryption');
    try {
      const votes = getAggregateVotesInPollMessage({
        message: pollData.msg.message,
        key: pollData.msg.key,
        pollUpdates
      }, authState.creds.me);
      console.log(`[POLL] PATH 1 votes: ${JSON.stringify(votes?.map(v => ({ name: v.name, count: v.voters?.length })))}`);
      if (votes && votes.length > 0) {
        for (const v of votes) {
          if (v.voters && v.voters.length > 0) { votedOption = v.name; break; }
        }
      }
      voterJid = pollData.jid;
      if (votedOption) console.log(`[POLL] PATH 1 SUCCESS: "${votedOption}" from ${voterJid}`);
    } catch (e) {
      console.error('[POLL] PATH 1 error:', e.message);
    }
  }

  // PATH 2: disk hash matching (after redeploy)
  if (!votedOption) {
    const diskData = await getPollOptions(pollMsgId);
    if (diskData) {
      console.log('[POLL] PATH 2: disk hash matching');
      voterJid = diskData.jid;
      for (const pu of pollUpdates) {
        const hashes = pu.vote?.selectedOptions || pu.selectedOptions || [];
        console.log(`[POLL] PATH 2: ${hashes.length} hash(es) to check`);
        for (const hash of hashes) {
          for (const optionName of diskData.options) {
            const expected = crypto.createHash('sha256').update(optionName).digest();
            const buf = Buffer.isBuffer(hash) ? hash : Buffer.from(hash);
            if (buf.equals(expected)) { votedOption = optionName; break; }
          }
          if (votedOption) break;
        }
        if (votedOption) break;
      }
      if (votedOption) {
        console.log(`[POLL] PATH 2 SUCCESS: "${votedOption}" from ${voterJid}`);
      } else {
        console.log('[POLL] PATH 2: No hash match — full debug:');
        for (const pu of pollUpdates) {
          const hashes = pu.vote?.selectedOptions || pu.selectedOptions || [];
          console.log(`[POLL-DBG] update keys: ${Object.keys(pu).join(', ')}`);
          for (const h of hashes) {
            console.log(`[POLL-DBG] received: ${Buffer.isBuffer(h) ? h.toString('hex') : Buffer.from(h).toString('hex')}`);
          }
        }
        for (const optName of (diskData.options || [])) {
          console.log(`[POLL-DBG] expected "${optName}": ${crypto.createHash('sha256').update(optName).digest('hex')}`);
        }
      }
    } else {
      console.log(`[POLL] PATH 2: No disk data for ${pollMsgId}`);
    }
  }

  if (votedOption && voterJid) {
    processedPollVotes.add(pollMsgId);
    setTimeout(() => processedPollVotes.delete(pollMsgId), 5 * 60 * 1000);
    await handlePollVote(voterJid, votedOption, sock);
    sentPolls.delete(pollMsgId);
  } else {
    console.log(`[POLL] FAILED to resolve vote — no option matched`);
  }
}

async function getWASocket() {
  const sessionDir = process.env.SESSION_DIR || './wa_session';
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  authState = state;
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

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (!qrShownOnce) { clearSignalKeys(); qrShownOnce = true; }
      qrImg = await QRCode.toDataURL(qr);
      status = 'qr_ready';
      console.log('[QR] QR code ready at /qr');
    }
    if (connection === 'open') {
      status = 'connected';
      qrImg = null;
      qrShownOnce = false;
      console.log('[WA] WhatsApp Connected!');
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
        qrShownOnce = false;
      }
    }
  });

  // ── messages.update: primary poll vote handler ──
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      // RAW DEBUG LOG — shows exactly what Baileys sends for every update
      const updateStr = JSON.stringify(update, (k, v) => Buffer.isBuffer(v) ? '[Buffer:' + v.toString('hex').slice(0,16) + ']' : v);
      console.log(`[RAW-UPDATE] key=${key?.id?.slice(0,12)} update=${updateStr.slice(0,300)}`);

      // Standard pollUpdates field
      if (update?.pollUpdates && update.pollUpdates.length > 0) {
        console.log('[EVENT] messages.update: pollUpdates found');
        await processPollVote(key.id, update.pollUpdates, 'messages.update');
        continue;
      }

      // Nested pollUpdateMessage inside update.message
      if (update?.message?.pollUpdateMessage) {
        console.log('[EVENT] messages.update: nested pollUpdateMessage');
        const pum = update.message.pollUpdateMessage;
        const origId = pum.pollCreationMessageKey?.id;
        if (origId) {
          await processPollVote(origId, [{ vote: pum.vote, pollUpdateMessageKey: key }], 'messages.update-nested');
        }
        continue;
      }
    }
  });

  // ── messages.upsert: secondary poll vote handler ──
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      // RAW DEBUG for any upsert
      if (msg.message) {
        const msgKeys = Object.keys(msg.message);
        console.log(`[RAW-UPSERT] type=${type} from=${msg.key?.remoteJid?.slice(0,20)} msgKeys=${msgKeys.join(',')}`);
      }

      if (msg.message?.pollUpdateMessage) {
        const pum = msg.message.pollUpdateMessage;
        console.log(`[EVENT] messages.upsert: pollUpdateMessage`);
        const origId = pum.pollCreationMessageKey?.id;
        if (origId) {
          await processPollVote(origId, [{ vote: pum.vote, pollUpdateMessageKey: msg.key }], 'messages.upsert');
        }
        continue;
      }

      if (msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV3) {
        console.log('[EVENT] messages.upsert: outgoing poll creation');
      }
    }
  });

  return sock;
}

function toJid(phone) {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
  if (n.startsWith('3') && n.length === 10) n = '92' + n;
  return n + '@s.whatsapp.net';
}

async function sendOrderConfirmation(phone, order) {
  const jid = toJid(phone);
  const confirmText = formatMessage('orderConfirmation', order);
  const pollResult = await safeSend(jid, {
    poll: { name: confirmText, values: POLL_OPTIONS, selectableCount: 1 }
  });
  if (pollResult && pollResult.key) {
    const pollMsgId = pollResult.key.id;
    sentPolls.set(pollMsgId, { jid, msg: pollResult });
    storePollOptions(pollMsgId, jid, POLL_OPTIONS);
    console.log(`[POLL] Stored poll ${pollMsgId} for ${jid} (memory + disk)`);
  }
  console.log(`[SEND] Confirmation + poll sent to ${phone}`);
}

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
