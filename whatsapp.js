const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { formatMessage } = require('./messageTemplates');

let sock = null, qrImg = null, status = 'disconnected';

const SESSION_DIR = process.env.SESSION_DIR || './wa_session';

// Clear signal key files when a new QR login starts.
// This prevents "Bad MAC" errors caused by stale signal sessions from previous instances.
// Keeps: creds.json, pending_state.json (order state)
// Deletes: session-*, pre-key-*, sender-key-*, app-state-* files
function clearSignalKeys() {
              try {
                              if (!fs.existsSync(SESSION_DIR)) return;
                              const files = fs.readdirSync(SESSION_DIR);
                              const toDelete = files.filter(function(f) {
                                                return f.startsWith('session-') ||
                                                                         f.startsWith('pre-key-') ||
                                                                         f.startsWith('sender-key-') ||
                                                                         f.startsWith('app-state-sync-') ||
                                                                         f.startsWith('app-state-version-') ||
                                                                         f === 'sender-key-memory.json';
                              });
                              for (const f of toDelete) {
                                                try { fs.unlinkSync(path.join(SESSION_DIR, f)); } catch (e) {}
                              }
                              if (toDelete.length > 0) {
                                                console.log('[Session] Cleared', toDelete.length, 'stale signal key files to prevent Bad MAC errors');
                              }
              } catch (e) {
                              console.error('[Session] Error clearing signal keys:', e.message);
              }
}

let qrShownOnce = false;

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

function enqueue(task) {
              messageQueue.push(task);
              processQueue();
}

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

async function waitForConnection(maxWaitMs) {
              if (!maxWaitMs) maxWaitMs = 120000;
              if (status === 'connected') return;
              console.log('[Queue] WhatsApp not connected, waiting up to ' + Math.round(maxWaitMs/1000) + 's...');
              const start = Date.now();
              while (status !== 'connected') {
                              if (Date.now() - start > maxWaitMs) throw new Error('WhatsApp not connected after ' + Math.round(maxWaitMs/1000) + 's');
                              await new Promise(resolve => setTimeout(resolve, 3000));
              }
              console.log('[Queue] WhatsApp reconnected, proceeding.');
}

// In-memory store for poll messages (survives within same instance)
// pollMsgId -> { jid, msg (full WAMessage) }
const sentPolls = new Map();

// SHA-256 hash an option name (same as WhatsApp does internally)
function hashOptionName(name) {
              return crypto.createHash('sha256').update(name).digest();
}

// Match hashes from poll vote to stored option names
function matchVotedOption(selectedHashes, options) {
              for (const option of options) {
                              const optHash = hashOptionName(option);
                              for (const selHash of selectedHashes) {
                                                const selBuf = Buffer.isBuffer(selHash) ? selHash : Buffer.from(selHash);
                                                if (optHash.equals(selBuf)) return option;
                              }
              }
              return null;
}

async function getWASocket() {
              const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
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
                                    // When QR is shown, a new login is happening.
                    // Clear stale signal keys to avoid "Bad MAC" on the new session.
                    if (!qrShownOnce) {
                                        qrShownOnce = true;
                                        clearSignalKeys();
                    }
                                    qrImg = await QRCode.toDataURL(qr);
                                    status = 'qr_ready';
                                    console.log('QR ready at /qr');
                  }
                  if (connection === 'open') {
                                    status = 'connected';
                                    qrImg = null;
                                    qrShownOnce = false; // reset for next potential logout
                    console.log('WhatsApp Connected!');
                                    if (messageQueue.length > 0) {
                                                        console.log('[Queue] Resuming ' + messageQueue.length + ' queued messages after reconnect.');
                                                        processQueue();
                                    }
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

  // Handle poll votes via messages.update
  // Uses dual-path: getAggregateVotesInPollMessage (if full msg available) OR hash matching (if only disk state available)
  sock.ev.on('messages.update', async (updates) => {
                  for (const update of updates) {
                                    try {
                                                        if (!update.update || !update.update.pollUpdates) continue;
                                                        const pollMsgId = update.key.id;
                                                        console.log('[POLL] messages.update received for poll ID:', pollMsgId);

                                      const { handlePollVote, findPendingJidForPoll, getPollOptions } = require('./orderManager');

                                      // PATH 1: Full poll message in memory (same instance as when poll was sent)
                                      const pollData = sentPolls.get(pollMsgId);
                                                        if (pollData && pollData.msg) {
                                                                              console.log('[POLL] PATH 1: Using getAggregateVotesInPollMessage');
                                                                              try {
                                                                                                      const result = await getAggregateVotesInPollMessage(
                                                                                                                  { message: pollData.msg.message, key: pollData.msg.key, pollUpdates: update.update.pollUpdates },
                                                                                                                                sock.authState.creds.me
                                                                                                                              );
                                                                                                      console.log('[POLL] Aggregated votes:', JSON.stringify(result));
                                                                                                      let votedOption = null;
                                                                                                      for (const option of result) {
                                                                                                                                if (option.voters && option.voters.length > 0) { votedOption = option.name; break; }
                                                                                                                  }
                                                                                                      if (votedOption) {
                                                                                                                                console.log('[POLL] Voted option:', votedOption);
                                                                                                                                await handlePollVote(pollData.jid, votedOption, sock);
                                                                                                                                continue;
                                                                                                                  } else {
                                                                                                                                console.log('[POLL] PATH 1: No voted option in aggregated result, trying PATH 2');
                                                                                                                  }
                                                                                          } catch (e) {
                                                                                                      console.error('[POLL] PATH 1 failed:', e.message, '- falling back to PATH 2');
                                                                                          }
                                                        }

                                      // PATH 2: Hash matching using disk-persisted pollOptionsStore (survives redeploys)
                                      console.log('[POLL] PATH 2: Using hash matching from disk-persisted pollOptionsStore');
                                                        const storedJid = findPendingJidForPoll(pollMsgId);
                                                        const storedOptions = getPollOptions(pollMsgId);
                                                        if (!storedJid || !storedOptions) {
                                                                              console.log('[POLL] PATH 2: No stored poll data for ID:', pollMsgId, '- vote cannot be processed');
                                                                              continue;
                                                        }

                                      // Extract selected hashes from all pollUpdates
                                      let votedOption = null;
                                                        for (const pu of update.update.pollUpdates) {
                                                                              const selectedHashes = (pu.vote && pu.vote.selectedOptions) || [];
                                                                              console.log('[POLL] PATH 2: selectedHashes count:', selectedHashes.length);
                                                                              if (selectedHashes.length > 0) {
                                                                                                      votedOption = matchVotedOption(selectedHashes, storedOptions);
                                                                                                      if (votedOption) break;
                                                                                          }
                                                        }

                                      if (votedOption) {
                                                            console.log('[POLL] PATH 2: Matched option:', votedOption, 'for jid:', storedJid);
                                                            await handlePollVote(storedJid, votedOption, sock);
                                      } else {
                                                            console.log('[POLL] PATH 2: Hash matching failed. PollUpdates:', JSON.stringify(update.update.pollUpdates).substring(0, 300));
                                      }
                                    } catch (e) {
                                                        console.error('[POLL] Error in messages.update:', e.message, e.stack);
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

async function safeSend(jid, messagePayload, typingDurationMs) {
              if (!typingDurationMs) typingDurationMs = 12000;
              await waitForConnection(120000);
              await enforcePerNumberCooldown(jid);
              await simulateTyping(jid, typingDurationMs);
              const sentMsg = await sock.sendMessage(jid, messagePayload);
              await randomDelay(1000, 2000);
              return sentMsg;
}

async function fastReply(jid, text) {
              try {
                              await waitForConnection(30000);
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
                                                                    console.log('[Queue] Sending confirmation to ' + phone);
                                                                    await waitForConnection(120000);
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
                                                                                          // Store full message in memory for PATH 1 decryption
                                                                      sentPolls.set(pollMsg.key.id, { jid: jid, msg: pollMsg });
                                                                                          // Also persist to disk for PATH 2 (survives redeploys)
                                                                      const { storePollOptions } = require('./orderManager');
                                                                                          storePollOptions(pollMsg.key.id, jid, POLL_OPTIONS);
                                                                                          console.log('[Queue] Stored poll for', pollMsg.key.id, '-> jid:', jid);
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
                                                                    await waitForConnection(120000);
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
                              await waitForConnection(60000);
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
                                                                    await waitForConnection(120000);
                                                                    await safeSend(jid, { text: formatMessage('fulfillment', order) }, 11000);
                                                                    console.log('[Done] Fulfillment sent to ' + phone);
                                                                    resolve();
                                                } catch (e) { reject(e); }
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
              getQRImage: function() { return qrImg; },
              getConnectionStatus: function() { return status; },
              getQueueLength: function() { return messageQueue.length; }
};
