const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { formatMessage } = require('./messageTemplates');

let sock = null, qrImg = null, status = 'disconnected';

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
                              console.log('[AntiBan] Waiting ' + Math.round(gap/1000) + 's...');
                              await new Promise(resolve => setTimeout(resolve, gap));
                }
      }
      isProcessingQueue = false;
}

function enqueue(task) { messageQueue.push(task); processQueue(); }

const lastSentTo = {};
async function enforcePerNumberCooldown(jid) {
      const now = Date.now(), last = lastSentTo[jid] || 0, elapsed = now - last, cooldown = 60000;
      if (elapsed < cooldown) {
                const wait = cooldown - elapsed + Math.floor(Math.random() * 10000);
                console.log('[AntiBan] Cooldown ' + jid + ' for ' + Math.round(wait/1000) + 's');
                await new Promise(resolve => setTimeout(resolve, wait));
      }
      lastSentTo[jid] = Date.now();
}

// Store sent poll messages for vote decryption
const sentPolls = new Map();

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
                            const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
                            if (code !== DisconnectReason.loggedOut) {
                                              console.log('Reconnecting in 5s...');
                                              setTimeout(getWASocket, 5000);
                            } else {
                                              console.log('Logged out. Re-scan QR.');
                            }
              }
    });

    // Handle incoming messages (for pollUpdateMessage in upsert)
    sock.ev.on('messages.upsert', async ({ messages }) => {
              for (const msg of messages) {
                            try {
                                              if (msg.message && msg.message.pollUpdateMessage) {
                                                                    const pollUpdate = msg.message.pollUpdateMessage;
                                                                    const voterJid = msg.key.remoteJid;
                                                                    console.log('[POLL-UPSERT] pollUpdateMessage from:', voterJid);
                                                                    const selectedHashes = (pollUpdate.vote && pollUpdate.vote.selectedOptions) || [];
                                                                    console.log('[POLL-UPSERT] selectedOptions count:', selectedHashes.length);
                                                                    if (selectedHashes.length > 0) {
                                                                                              const { handlePollVoteByHash } = require('./orderManager');
                                                                                              await handlePollVoteByHash(voterJid, selectedHashes, pollUpdate, sock);
                                                                    }
                                              }
                            } catch (e) {
                                              console.error('[POLL-UPSERT] Error:', e.message);
                            }
              }
    });

    // Handle poll vote updates via messages.update (Baileys delivers decrypted votes here)
    sock.ev.on('messages.update', async (updates) => {
              for (const update of updates) {
                            try {
                                              const pollUpdate = update.update && update.update.pollUpdates;
                                              if (pollUpdate && pollUpdate.length > 0) {
                                                                    console.log('[POLL-UPDATE] Poll update received for msg:', update.key.id);
                                                                    for (const pu of pollUpdate) {
                                                                                              const voterJid = pu.voter || update.key.remoteJid;
                                                                                              const selectedOptions = pu.selectedOptions || [];
                                                                                              console.log('[POLL-UPDATE] Voter:', voterJid, 'Selected:', JSON.stringify(selectedOptions));

                                                                        if (selectedOptions.length > 0) {
                                                                                                      // selectedOptions contains the actual option text strings
                                                                                                  const optionName = selectedOptions[0];
                                                                                                      console.log('[POLL-UPDATE] Vote option text:', optionName);
                                                                                                      const { handlePollVote } = require('./orderManager');
                                                                                                      // Use voter JID (remove :XX@lid suffix if present)
                                                                                                  let cleanJid = voterJid;
                                                                                                      if (cleanJid && cleanJid.includes('@lid')) {
                                                                                                                                        // Try to get the actual phone JID from our pending orders
                                                                                                          const { findPendingJidForPoll } = require('./orderManager');
                                                                                                                                        const pollMsgId = update.key.id;
                                                                                                                                        cleanJid = findPendingJidForPoll(pollMsgId) || voterJid;
                                                                                                        }
                                                                                                      await handlePollVote(cleanJid, optionName, sock);
                                                                        }
                                                                    }
                                              }
                            } catch (e) {
                                              console.error('[POLL-UPDATE] Error:', e.message, e.stack);
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

function ensureConn() { if (status !== 'connected') throw new Error('WhatsApp not connected'); }

async function safeSend(jid, messagePayload, typingDurationMs) {
      if (!typingDurationMs) typingDurationMs = 12000;
      ensureConn();
      await enforcePerNumberCooldown(jid);
      await simulateTyping(jid, typingDurationMs);
      const sentMsg = await sock.sendMessage(jid, messagePayload);
      await randomDelay(1000, 2000);
      return sentMsg;
}

async function fastReply(jid, text) {
      try {
                ensureConn();
                await simulateTyping(jid, 3000);
                await sock.sendMessage(jid, { text: text });
                lastSentTo[jid] = Date.now();
                console.log('[FastReply] Sent to', jid);
      } catch (e) {
                console.error('[FastReply] Error:', e.message);
      }
}

const POLL_OPTIONS = [
      'Confirm \u2705 (Cash On Delivery)',
      'Confirm \u2705 Advance Payment  (EXTRA 150/- Discount)'
  ];

async function sendOrderConfirmation(phone, order) {
      const jid = toJid(phone);
      return new Promise(function(resolve, reject) {
                enqueue(async function() {
                              try {
                                                ensureConn();
                                                console.log('[Queue] Sending confirmation to ' + phone);

                                  await safeSend(jid, { text: formatMessage('orderConfirmation', order) }, 13000);

                                  await randomDelay(3000, 6000);
                                                await simulateTyping(jid, 4000);

                                  const pollMsg = await sock.sendMessage(jid, {
                                                        poll: {
                                                                                  name: 'Please confirm your order:',
                                                                                  values: POLL_OPTIONS,
                                                                                  selectableCount: 1
                                                        }
                                  });

                                  if (pollMsg && pollMsg.key && pollMsg.key.id) {
                                                        const { storePollOptions } = require('./orderManager');
                                                        storePollOptions(pollMsg.key.id, jid, POLL_OPTIONS);
                                                        sentPolls.set(pollMsg.key.id, { jid: jid, options: POLL_OPTIONS });
                                                        console.log('[Queue] Stored poll options for', pollMsg.key.id);
                                  }

                                  lastSentTo[jid] = Date.now();
                                                console.log('[Done] Confirmation sent to ' + phone);
                                                resolve();
                              } catch (e) {
                                                console.error('[Error] Confirmation failed:', e.message);
                                                reject(e);
                              }
                });
      });
}

async function sendAbandonedCheckout(phone, checkout) {
      const jid = toJid(phone);
      return new Promise(function(resolve, reject) {
                enqueue(async function() {
                              try {
                                                ensureConn();
                                                await safeSend(jid, { text: formatMessage('abandonedCheckout', checkout) }, 12000);
                                                console.log('[Done] Abandoned cart sent to ' + phone);
                                                resolve();
                              } catch (e) { reject(e); }
                });
      });
}

async function sendAdminNotification(phone, order) {
      const jid = toJid(phone);
      try {
                ensureConn();
                await simulateTyping(jid, 3000);
                await sock.sendMessage(jid, { text: formatMessage('adminNotification', order) });
                console.log('[Done] Admin notification sent');
      } catch (e) {
                console.error('[Error] Admin notification failed:', e.message);
      }
}

async function sendFulfillmentNotification(phone, order) {
      const jid = toJid(phone);
      return new Promise(function(resolve, reject) {
                enqueue(async function() {
                              try {
                                                ensureConn();
                                                await safeSend(jid, { text: formatMessage('fulfillment', order) }, 11000);
                                                console.log('[Done] Fulfillment sent to ' + phone);
                                                resolve();
                              } catch (e) { reject(e); }
                });
      });
}

module.exports = {
      getWASocket: getWASocket,
      sendOrderConfirmation: sendOrderConfirmation,
      sendAbandonedCheckout: sendAbandonedCheckout,
      sendAdminNotification: sendAdminNotification,
      sendFulfillmentNotification: sendFulfillmentNotification,
      fastReply: fastReply,
      getQRImage: function() { return qrImg; },
      getConnectionStatus: function() { return status; },
      getQueueLength: function() { return messageQueue.length; }
};
