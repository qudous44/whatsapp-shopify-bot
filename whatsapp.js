const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { formatMessage } = require('./messageTemplates');

let sock = null, qrImg = null, status = 'disconnected';
// Store message store for poll decryption
const msgStore = {};

// ─────────────────────────────────────────────
// ANTI-BAN SYSTEM (WhatFlow-style)
// ─────────────────────────────────────────────
function randomDelay(minMs, maxMs) {
      const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
      return new Promise(resolve => setTimeout(resolve, ms));
}

async function simulateTyping(jid, durationMs) {
      try {
              await sock.sendPresenceUpdate('composing', jid);
              await randomDelay(durationMs - 2000, durationMs + 2000);
              await sock.sendPresenceUpdate('paused', jid);
              await randomDelay(500, 1000);
      } catch (e) {}
}

// Global queue - serializes ALL outgoing messages
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
      if (isProcessingQueue) return;
      isProcessingQueue = true;
      while (messageQueue.length > 0) {
              const task = messageQueue.shift();
              try { await task(); } catch (e) { console.error('[Queue] Task failed:', e.message); }
              if (messageQueue.length > 0) {
                        const gap = Math.floor(Math.random() * 30000) + 30000;
                        console.log(`[AntiBan] Waiting ${Math.round(gap/1000)}s before next msg...`);
                        await new Promise(resolve => setTimeout(resolve, gap));
              }
      }
      isProcessingQueue = false;
}

function enqueue(task) {
      messageQueue.push(task);
      processQueue();
}

// Per-number cooldown (60s minimum between sends to same number)
const lastSentTo = {};
async function enforcePerNumberCooldown(jid) {
      const now = Date.now();
      const last = lastSentTo[jid] || 0;
      const elapsed = now - last;
      const cooldown = 60000;
      if (elapsed < cooldown) {
              const wait = cooldown - elapsed + Math.floor(Math.random() * 10000);
              console.log(`[AntiBan] Cooldown ${jid} for ${Math.round(wait/1000)}s`);
              await new Promise(resolve => setTimeout(resolve, wait));
      }
      lastSentTo[jid] = Date.now();
}

// ─────────────────────────────────────────────
// WHATSAPP CONNECTION
// ─────────────────────────────────────────────
async function getWASocket() {
      const { state, saveCreds } = await useMultiFileAuthState(process.env.SESSION_DIR || './wa_session');
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
              generateHighQualityLinkPreview: false,
              syncFullHistory: false,
      });

  sock.ev.on('creds.update', saveCreds);

  // Store messages for poll decryption
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
          for (const msg of messages) {
                    if (msg.key && msg.message) {
                                msgStore[msg.key.id] = msg;
                    }
          }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
          if (qr) {
                    qrImg = await QRCode.toDataURL(qr);
                    status = 'qr_ready';
                    console.log('QR ready at /qr');
          }
          if (connection === 'open') {
                    status = 'connected';
                    qrImg = null;
                    console.log('WhatsApp Connected!');
          }
          if (connection === 'close') {
                    status = 'disconnected';
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code !== DisconnectReason.loggedOut) {
                                console.log('Reconnecting in 5s...');
                                setTimeout(getWASocket, 5000);
                    } else {
                                console.log('Logged out. Re-scan QR.');
                    }
          }
  });

  // POLL VOTE DETECTION - uses messages.update (correct Baileys event for polls)
  sock.ev.on('messages.update', async (updates) => {
          for (const update of updates) {
                    try {
                                if (!update.update?.pollUpdates) continue;
                                console.log('[POLL] Poll update received from:', update.key.remoteJid);

                      // Find the original poll message from store
                      const pollMsgId = update.key.id;
                                const originalMsg = msgStore[pollMsgId];

                      if (!originalMsg) {
                                    console.log('[POLL] Original poll message not in store, trying to fetch...');
                                    // Still try to handle with available data
                                  const pollUpdates = update.update.pollUpdates;
                                    for (const pollVote of pollUpdates) {
                                                    const voter = pollVote.pollUpdateMessageKey?.remoteJid || update.key.remoteJid;
                                                    // Try to get vote from raw pollUpdate
                                      const selectedOpts = pollVote.vote?.selectedOptions || [];
                                                    if (selectedOpts.length > 0) {
                                                                      const optionName = selectedOpts[0];
                                                                      console.log('[POLL] Vote detected (raw):', optionName, 'from', voter);
                                                                      const { handlePollVote } = require('./orderManager');
                                                                      await handlePollVote(voter, optionName, sock);
                                                    }
                                    }
                                    continue;
                      }

                      // Use Baileys built-in aggregator to decrypt poll votes
                      const pollVotes = getAggregateVotesInPollMessage({
                                    message: originalMsg.message,
                                    pollUpdates: update.update.pollUpdates,
                      });

                      console.log('[POLL] Aggregated votes:', JSON.stringify(pollVotes));

                      // Find which option(s) got new votes
                      for (const opt of pollVotes) {
                                    if (opt.voters && opt.voters.length > 0) {
                                                    const voterJid = update.key.remoteJid;
                                                    console.log('[POLL] Option selected:', opt.name, 'by:', voterJid);
                                                    const { handlePollVote } = require('./orderManager');
                                                    await handlePollVote(voterJid, opt.name, sock);
                                                    break; // Only handle first selected option
                                    }
                      }
                    } catch (e) {
                                console.error('[POLL] Error handling poll update:', e.message);
                    }
          }
  });

  return sock;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function toJid(phone) {
      let n = String(phone).replace(/\D/g, '');
      if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
      if (n.startsWith('3') && n.length === 10) n = '92' + n;
      return n + '@s.whatsapp.net';
}

function ensureConn() {
      if (status !== 'connected') throw new Error('WhatsApp not connected');
}

// Core send: typing simulation + cooldown
async function safeSend(jid, messagePayload, typingDurationMs = 12000) {
      ensureConn();
      await enforcePerNumberCooldown(jid);
      await simulateTyping(jid, typingDurationMs);
      await sock.sendMessage(jid, messagePayload);
      await randomDelay(1000, 2000);
}

// Fast send for poll replies (no cooldown, no queue — immediate response)
async function fastReply(jid, text) {
      try {
              ensureConn();
              await simulateTyping(jid, 3000);
              await sock.sendMessage(jid, { text });
              lastSentTo[jid] = Date.now();
              console.log('[FastReply] Sent to', jid);
      } catch (e) {
              console.error('[FastReply] Error:', e.message);
      }
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────
async function sendOrderConfirmation(phone, order) {
      const jid = toJid(phone);
      return new Promise((resolve, reject) => {
              enqueue(async () => {
                        try {
                                    ensureConn();
                                    console.log(`[Queue] Sending order confirmation to ${phone}`);
                                    await safeSend(jid, { text: formatMessage('orderConfirmation', order) }, 13000);
                                    await randomDelay(3000, 6000);
                                    await simulateTyping(jid, 4000);
                                    await sock.sendMessage(jid, {
                                                  poll: {
                                                                  name: 'Please confirm your order:',
                                                                  values: [
                                                                                    'Confirm (Cash On Delivery)',
                                                                                    'Confirm Advance Payment (EXTRA Rs.150/- Discount)',
                                                                                    'Cancel Order'
                                                                                  ],
                                                                  selectableCount: 1
                                                  }
                                    });
                                    // Store poll message for later decryption
                          lastSentTo[jid] = Date.now();
                                    console.log(`[Done] Confirmation sent to ${phone}`);
                                    resolve();
                        } catch (e) {
                                    console.error(`[Error] Confirmation failed for ${phone}:`, e.message);
                                    reject(e);
                        }
              });
      });
}

async function sendAbandonedCheckout(phone, checkout) {
      const jid = toJid(phone);
      return new Promise((resolve, reject) => {
              enqueue(async () => {
                        try {
                                    ensureConn();
                                    console.log(`[Queue] Sending abandoned cart to ${phone}`);
                                    await safeSend(jid, { text: formatMessage('abandonedCheckout', checkout) }, 12000);
                                    console.log(`[Done] Abandoned cart sent to ${phone}`);
                                    resolve();
                        } catch (e) {
                                    console.error(`[Error] Abandoned cart failed:`, e.message);
                                    reject(e);
                        }
              });
      });
}

// Admin notification: bypasses queue, sends immediately (no customer delay)
async function sendAdminNotification(phone, order) {
      const jid = toJid(phone);
      try {
              ensureConn();
              await simulateTyping(jid, 3000);
              await sock.sendMessage(jid, { text: formatMessage('adminNotification', order) });
              console.log(`[Done] Admin notification sent`);
      } catch (e) {
              console.error(`[Error] Admin notification failed:`, e.message);
      }
}

async function sendFulfillmentNotification(phone, order) {
      const jid = toJid(phone);
      return new Promise((resolve, reject) => {
              enqueue(async () => {
                        try {
                                    ensureConn();
                                    console.log(`[Queue] Sending fulfillment to ${phone}`);
                                    await safeSend(jid, { text: formatMessage('fulfillment', order) }, 11000);
                                    console.log(`[Done] Fulfillment sent to ${phone}`);
                                    resolve();
                        } catch (e) {
                                    console.error(`[Error] Fulfillment failed:`, e.message);
                                    reject(e);
                        }
              });
      });
}

module.exports = {
      getWASocket,
      sendOrderConfirmation,
      sendAbandonedCheckout,
      sendAdminNotification,
      sendFulfillmentNotification,
      fastReply,
      getQRImage: () => qrImg,
      getConnectionStatus: () => status,
      getQueueLength: () => messageQueue.length
};
