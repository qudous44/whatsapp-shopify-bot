const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { formatMessage } = require('./messageTemplates');

let sock = null, qrImg = null, status = 'disconnected';

// ─────────────────────────────────────────────
// ANTI-BAN SYSTEM
// Modeled after professional tools like WhatFlow
// ─────────────────────────────────────────────

// Random delay between min and max milliseconds (human-like variation)
function randomDelay(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Simulate typing indicator before sending (exactly like WhatFlow: 10-15s)
async function simulateTyping(jid, durationMs) {
    try {
          await sock.sendPresenceUpdate('composing', jid);
          await randomDelay(durationMs - 2000, durationMs + 2000);
          await sock.sendPresenceUpdate('paused', jid);
          await randomDelay(500, 1500);
    } catch (e) {
          // ignore presence errors, still send message
    }
}

// Global message queue — serializes ALL outgoing messages
// so they NEVER fire simultaneously
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (messageQueue.length > 0) {
          const task = messageQueue.shift();
          try {
                  await task();
          } catch (e) {
                  console.error('[Queue] Task failed:', e.message);
          }
          // Minimum 30s gap between any two sends (random 30-60s like WhatFlow)
      if (messageQueue.length > 0) {
              const gap = Math.floor(Math.random() * 30000) + 30000; // 30-60 seconds
            console.log(`[AntiBan] Waiting ${Math.round(gap/1000)}s before next message...`);
              await new Promise(resolve => setTimeout(resolve, gap));
      }
    }
    isProcessingQueue = false;
}

function enqueue(task) {
    messageQueue.push(task);
    processQueue();
}

// Per-number last-sent tracker (minimum 60s cooldown per number)
const lastSentTo = {};

async function enforcePerNumberCooldown(jid) {
    const now = Date.now();
    const last = lastSentTo[jid] || 0;
    const elapsed = now - last;
    const cooldown = 60000; // 60 seconds minimum per number
  if (elapsed < cooldown) {
        const wait = cooldown - elapsed + Math.floor(Math.random() * 10000);
        console.log(`[AntiBan] Cooling down ${jid} for ${Math.round(wait/1000)}s`);
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
                if (msg.key.fromMe) continue;
                const pollUpdate = msg.message?.pollUpdateMessage;
                if (pollUpdate) {
                          const sel = pollUpdate.vote?.selectedOptions?.[0];
                          if (sel) {
                                      const { handlePollVote } = require('./orderManager');
                                      await handlePollVote(msg.key.remoteJid, sel, sock);
                          }
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

// ─────────────────────────────────────────────
// CORE SEND FUNCTION (all messages go through here)
// Typing simulation + per-number cooldown + queue
// ─────────────────────────────────────────────

async function safeSend(jid, messagePayload, typingDurationMs = 12000) {
    ensureConn();
    await enforcePerNumberCooldown(jid);
    // Show typing indicator for 10-15 seconds (exactly like WhatFlow)
  await simulateTyping(jid, typingDurationMs);
    await sock.sendMessage(jid, messagePayload);
    // Small pause after sending (like a human finishing typing)
  await randomDelay(1000, 3000);
}

// ─────────────────────────────────────────────
// PUBLIC API — all enqueued for serialization
// ─────────────────────────────────────────────

async function sendOrderConfirmation(phone, order) {
    const jid = toJid(phone);
    return new Promise((resolve, reject) => {
          enqueue(async () => {
                  try {
                            ensureConn();
                            console.log(`[Queue] Sending order confirmation to ${phone}`);
                            // Send text message with typing simulation (12-15s typing)
                    await safeSend(jid, { text: formatMessage('orderConfirmation', order) }, 13000);
                            // Extra delay between text and poll (3-7 seconds, human-like)
                    await randomDelay(3000, 7000);
                            // Show typing again before poll
                    await simulateTyping(jid, 5000);
                            // Send poll
                    await sock.sendMessage(jid, {
                                poll: {
                                              name: 'Please confirm your order:',
                                              values: [
                                                              'Confirm (Cash On Delivery)',
                                                              'Confirm Advance Payment  (EXTRA Rs.150/- Discount)',
                                                              'Cancel Order'
                                                            ],
                                              selectableCount: 1
                                }
                    });
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
                            console.error(`[Error] Abandoned cart failed for ${phone}:`, e.message);
                            reject(e);
                  }
          });
    });
}

async function sendAdminNotification(phone, order) {
    const jid = toJid(phone);
    return new Promise((resolve, reject) => {
          enqueue(async () => {
                  try {
                            ensureConn();
                            // Admin notifications get shorter typing (5-8s) since it's internal
                    await safeSend(jid, { text: formatMessage('adminNotification', order) }, 6000);
                            console.log(`[Done] Admin notification sent`);
                            resolve();
                  } catch (e) {
                            console.error(`[Error] Admin notification failed:`, e.message);
                            reject(e);
                  }
          });
    });
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
                            console.error(`[Error] Fulfillment failed for ${phone}:`, e.message);
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
    getQRImage: () => qrImg,
    getConnectionStatus: () => status,
    getQueueLength: () => messageQueue.length
};
