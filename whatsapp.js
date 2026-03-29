const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys');
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

// ══════════════════════════════════════════════════════════
// MESSAGE STORE — required by Baileys for poll vote decryption
// getMessage is called internally by Baileys when processing
// messages.update poll events. Without it, votes can't decrypt.
// ══════════════════════════════════════════════════════════
const messageStore = new Map();

function storeMessage(msg) {
    if (!msg?.key?.id) return;
    const key = `${msg.key.remoteJid}:${msg.key.id}`;
    messageStore.set(key, msg);
    // Auto-cleanup after 24 hours to prevent memory leaks
    setTimeout(() => messageStore.delete(key), 24 * 60 * 60 * 1000);
}

async function getMessage(key) {
    // First check in-memory store
    const storeKey = `${key.remoteJid}:${key.id}`;
    const memMsg = messageStore.get(storeKey);
    if (memMsg?.message) {
        console.log(`[STORE] getMessage hit (memory) for ${key.id}`);
        return memMsg.message;
    }

    // Fallback to Redis (survives redeploys)
    try {
        const redisData = await getPollOptions(key.id);
        if (redisData?.msg?.message) {
            console.log(`[STORE] getMessage hit (Redis) for ${key.id}`);
            return redisData.msg.message;
        }
    } catch (e) {
        console.error(`[STORE] Redis getMessage error:`, e.message);
    }

    console.log(`[STORE] getMessage miss for ${key.id}`);
    return undefined;
}

// In-memory map: pollMsgId -> { jid, msg (full WAMessage) }
// Used for same-instance vote decryption (PATH 1)
const sentPolls = new Map();
const messageQueue = [];
const processedPollVotes = new Set();

const POLL_OPTIONS = [
    'Confirm ✅ (Cash On Delivery)',
    'Confirm ✅ Advance Payment (EXTRA 150/- Discount)',
    'Cancel Order'
];

function clearSignalKeys() {
    const sessionDir = process.env.SESSION_DIR || './wa_session';
    if (!fs.existsSync(sessionDir)) return;
    const patterns = [
        /^session-/, /^pre-key-/, /^sender-key-/,
        /^app-state-sync-/, /^app-state-version-/,
        /^sender-key-memory\.json$/
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
        console.log(`[WAIT] Waiting up to ${maxWaitMs / 1000}s for WA...`);
        const start = Date.now();
        const interval = setInterval(() => {
            if (status === 'connected') { clearInterval(interval); resolve(); }
            else if (Date.now() - start > maxWaitMs) { clearInterval(interval); reject(new Error('WA timeout')); }
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
        try { await fn(...args); } catch (e) { console.error('[QUEUE]', e.message); }
    }
}

// ══════════════════════════════════════════════════════════
// CORE POLL VOTE PROCESSOR
// PATH 1: same-instance — use in-memory sentPolls + getAggregateVotesInPollMessage
// PATH 1b: after-redeploy — use Redis-stored WAMessage + getAggregateVotesInPollMessage
// PATH 2: fallback — SHA-256 hash matching (only works if vote.selectedOptions is populated)
// ══════════════════════════════════════════════════════════
async function processPollVote(pollMsgId, pollUpdates, source) {
    if (processedPollVotes.has(pollMsgId)) {
        console.log(`[POLL] Duplicate vote ignored for ${pollMsgId}`);
        return;
    }

    console.log(`[POLL] Processing vote for ${pollMsgId} via ${source}`);
    console.log(`[POLL] pollUpdates: ${JSON.stringify(pollUpdates, (k,v) => Buffer.isBuffer(v) ? '[Buffer]' : v)}`);

    let votedOption = null;
    let voterJid = null;

    // FIX: meId must be a string, not the full creds.me object
    const meId = authState?.creds?.me?.id;
    if (!meId) {
        console.error('[POLL] No meId available — authState not ready');
        return;
    }

    // ── PATH 1: Same instance, full WAMessage in memory ──
    const memData = sentPolls.get(pollMsgId);
    if (memData && memData.msg) {
        console.log('[POLL] PATH 1: in-memory decryption');
        // Debug: check if messageSecret exists
        const hasSecret = !!memData.msg.message?.messageContextInfo?.messageSecret;
        console.log(`[POLL] PATH 1: messageSecret present: ${hasSecret}`);
        try {
            const votes = getAggregateVotesInPollMessage({
                message: memData.msg.message,
                key: memData.msg.key,
                pollUpdates
            }, meId);  // FIX: pass string meId, not object

            console.log(`[POLL] PATH 1 votes: ${JSON.stringify(votes?.map(v => ({ name: v.name, count: v.voters?.length })))}`);

            for (const v of (votes || [])) {
                if (v.voters && v.voters.length > 0) {
                    votedOption = v.name;
                    break;
                }
            }
            voterJid = memData.jid;
            if (votedOption) console.log(`[POLL] PATH 1 SUCCESS: "${votedOption}"`);
        } catch (e) {
            console.error('[POLL] PATH 1 error:', e.message);
        }
    }

    // ── PATH 1b: After redeploy — load WAMessage from Redis ──
    if (!votedOption) {
        const diskData = await getPollOptions(pollMsgId);

        if (diskData && diskData.msg) {
            console.log('[POLL] PATH 1b: Redis WAMessage decryption');
            const hasSecret = !!diskData.msg.message?.messageContextInfo?.messageSecret;
            console.log(`[POLL] PATH 1b: messageSecret present: ${hasSecret}`);
            voterJid = diskData.jid;

            try {
                const votes = getAggregateVotesInPollMessage({
                    message: diskData.msg.message,
                    key: diskData.msg.key,
                    pollUpdates
                }, meId);  // FIX: pass string meId, not object

                console.log(`[POLL] PATH 1b votes: ${JSON.stringify(votes?.map(v => ({ name: v.name, count: v.voters?.length })))}`);

                for (const v of (votes || [])) {
                    if (v.voters && v.voters.length > 0) {
                        votedOption = v.name;
                        break;
                    }
                }
                if (votedOption) console.log(`[POLL] PATH 1b SUCCESS: "${votedOption}"`);
            } catch (e) {
                console.error('[POLL] PATH 1b error:', e.message);
            }

            // ── PATH 2: SHA-256 hash fallback ──
            if (!votedOption) {
                console.log('[POLL] PATH 2: SHA-256 hash fallback');
                for (const pu of pollUpdates) {
                    const hashes = pu.vote?.selectedOptions || pu.selectedOptions || [];
                    console.log(`[POLL] PATH 2: ${hashes.length} hash(es)`);
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
                if (votedOption) console.log(`[POLL] PATH 2 SUCCESS: "${votedOption}"`);
            }
        } else if (diskData && !diskData.msg) {
            console.log('[POLL] Redis data found but no WAMessage stored — PATH 2 only');
            voterJid = diskData.jid;
            for (const pu of pollUpdates) {
                const hashes = pu.vote?.selectedOptions || pu.selectedOptions || [];
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
        } else {
            console.log(`[POLL] No Redis data for ${pollMsgId}`);
        }
    }

    if (votedOption && voterJid) {
        processedPollVotes.add(pollMsgId);
        setTimeout(() => processedPollVotes.delete(pollMsgId), 5 * 60 * 1000);
        await handlePollVote(voterJid, votedOption, sock);
        sentPolls.delete(pollMsgId);
    } else {
        console.log('[POLL] FAILED — could not resolve vote option');
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

        // ══════════════════════════════════════════════════
        // FIX: getMessage is REQUIRED for poll vote decryption.
        // Baileys calls this internally when processing
        // messages.update events with pollUpdates.
        // Without it, votes return 0 voters for all options.
        // ══════════════════════════════════════════════════
        getMessage: getMessage,
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
            console.log('[WA] Connected!');
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
                console.log('[WA] Logged out.');
                qrShownOnce = false;
            }
        }
    });

    // ── messages.upsert: Store all messages + detect poll votes ──
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        for (const msg of msgs) {
            // FIX: Store ALL messages in the store so getMessage can find them
            storeMessage(msg);

            if (msg.message?.pollUpdateMessage) {
                const pum = msg.message.pollUpdateMessage;
                console.log(`[EVENT] messages.upsert: pollUpdateMessage from ${msg.key?.remoteJid}`);
                const origId = pum.pollCreationMessageKey?.id;
                if (origId) {
                    const pollUpdates = [{
                        pollUpdateMessageKey: msg.key,
                        vote: pum.vote,
                        senderTimestampMs: pum.senderTimestampMs
                    }];
                    await processPollVote(origId, pollUpdates, 'messages.upsert');
                }
            }
        }
    });

    // ── messages.update: Baileys delivers poll votes here ──
    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            if (update?.pollUpdates && update.pollUpdates.length > 0) {
                console.log(`[EVENT] messages.update: pollUpdates for ${key.id}`);
                await processPollVote(key.id, update.pollUpdates, 'messages.update');
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

        // Store in message store (for getMessage callback)
        storeMessage(pollResult);

        // Store in memory (PATH 1 — same instance)
        sentPolls.set(pollMsgId, { jid, msg: pollResult });

        // Store in Redis WITH full WAMessage (PATH 1b — after redeploy)
        await storePollOptions(pollMsgId, jid, POLL_OPTIONS, pollResult);

        // Debug: verify messageSecret is present
        const hasSecret = !!pollResult.message?.messageContextInfo?.messageSecret;
        console.log(`[POLL] Stored poll ${pollMsgId} (memory + Redis with WAMessage, messageSecret: ${hasSecret})`);
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
