const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PENDING_PREFIX = 'pending:';
const POLL_PREFIX = 'poll:';
const TTL = 24 * 60 * 60; // 24 hours

function toJid(phone) {
    let n = String(phone).replace(/\D/g, '');
    if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
    if (n.startsWith('3') && n.length === 10) n = '92' + n;
    return n + '@s.whatsapp.net';
}

async function registerPendingOrder(phone, order) {
    const jid = toJid(phone);
    await redis.set(
        PENDING_PREFIX + jid,
        { orderId: order.id, orderNumber: order.order_number, timestamp: Date.now() },
        { ex: TTL }
    );
    console.log(`[PENDING] Registered order #${order.order_number} for ${jid}`);
}

// ══════════════════════════════════════════════════════════
// Serialize WAMessage to JSON
// Handles Buffer, Uint8Array, and Long objects that appear
// in Baileys protobuf messages. Without this, messageSecret
// and other binary fields get corrupted in Redis.
// ══════════════════════════════════════════════════════════
function serializeWAMessage(pollWAMessage) {
    if (!pollWAMessage) return null;
    try {
        return JSON.stringify(pollWAMessage, (k, v) => {
            // Handle Node.js Buffer serialized as { type: 'Buffer', data: [...] }
            if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
                return { __type: 'Buffer', data: Buffer.from(v.data).toString('base64') };
            }
            // Handle actual Buffer instances
            if (Buffer.isBuffer(v)) {
                return { __type: 'Buffer', data: v.toString('base64') };
            }
            // FIX: Handle Uint8Array (protobuf bytes fields like messageSecret)
            // Uint8Array is NOT caught by Buffer.isBuffer() in some cases
            if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
                return { __type: 'Buffer', data: Buffer.from(v).toString('base64') };
            }
            // Handle Long objects from protobuf (senderTimestampMs etc.)
            if (v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number') {
                // Convert Long to number (safe for timestamps)
                if (typeof v.toNumber === 'function') return v.toNumber();
                return v.low; // fallback: use low 32 bits
            }
            return v;
        });
    } catch (e) {
        console.error('[POLL-STORE] Failed to serialize WAMessage:', e.message);
        return null;
    }
}

// Deserialize WAMessage from JSON, restoring Buffers
function deserializeWAMessage(msgJson) {
    if (!msgJson) return null;
    try {
        return JSON.parse(msgJson, (k, v) => {
            if (v && typeof v === 'object' && v.__type === 'Buffer') {
                return Buffer.from(v.data, 'base64');
            }
            return v;
        });
    } catch (e) {
        console.error('[POLL-GET] Failed to deserialize WAMessage:', e.message);
        return null;
    }
}

// ── Store poll options + full WAMessage to Redis ──
async function storePollOptions(pollMsgId, jid, options, pollWAMessage) {
    const msgJson = serializeWAMessage(pollWAMessage);

    await redis.set(
        POLL_PREFIX + pollMsgId,
        { jid, options, timestamp: Date.now(), msgJson },
        { ex: TTL }
    );
    console.log(`[POLL-STORE] Stored poll ${pollMsgId} for ${jid} with ${options.length} options (msg: ${msgJson ? 'yes' : 'no'})`);
}

// ── Get poll data from Redis ──
async function getPollOptions(pollMsgId) {
    const data = await redis.get(POLL_PREFIX + pollMsgId);
    if (!data) return null;

    data.msg = deserializeWAMessage(data.msgJson);
    return data;
}

async function handlePollVote(jid, votedOption, sock) {
    const opt = votedOption.toLowerCase();
    console.log(`[VOTE] Processing vote from ${jid}: "${votedOption}"`);

    const p = await redis.get(PENDING_PREFIX + jid);
    if (!p) {
        console.log(`[VOTE] No pending order found for ${jid}`);
    }

    let msg = '', tag = '';

    if (opt.includes('cash') || (opt.includes('confirm') && !opt.includes('advance'))) {
        msg = '✅ *Order Confirmed! (Cash on Delivery)*\n\nShukriya! Aapka order confirm ho gaya hai. 🎉\nDelivery pe courier ko payment karein.\n\n*Gulshan-e-Fashion* 🛍️';
        tag = '✅ Order Confirmed';
    } else if (opt.includes('advance') || opt.includes('150')) {
        msg = '💳 *Advance Payment Selected!*\n\nTotal amount me se *Rs.150 kam* hamare account me bhej dein.\nScreenshot share karein — order process ho jayega. ✅\n\n*Bank Details:*\n\n🏦 Bank: UBL\n👤 Title: Gulshan e Fashion\n🔢 Account No: 2661350931229\n🇵🇰 IBAN: PK13UNIL0109000350931229\n\n_Agar payment receive na hui to order COD full amount par dispatch hoga._';
        tag = '✅ Paid Order (Verify Payment)';
    } else if (opt.includes('cancel')) {
        msg = '❌ *Order Cancelled*\n\nAapka order cancel kar diya gaya hai.\n\nDobara order: gulshanefashion.com\n\n*Gulshan-e-Fashion* 😊';
        tag = 'Cancelled';
    }

    if (msg) {
        try {
            await sock.sendMessage(jid, { text: msg });
            console.log(`[VOTE] Reply sent to ${jid}`);
        } catch (e) {
            console.error(`[VOTE] Failed to send reply:`, e.message);
        }
    } else {
        console.warn(`[VOTE] No reply template matched for option: "${votedOption}" — check condition strings`);
    }

    if (p && tag) {
        const headers = {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
        };
        const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/orders/${p.orderId}.json`;

        try {
            const g = await axios.get(url, { headers });
            const existing = g.data.order.tags || '';
            const updated = existing
                ? [...new Set([...existing.split(', '), tag])].join(', ')
                : tag;

            await axios.put(url, { order: { id: p.orderId, tags: updated } }, { headers });
            console.log(`[TAG] Order ${p.orderId} (#${p.orderNumber}) tagged → "${tag}"`);
        } catch (e) {
            console.error(`[TAG] Failed to tag order:`, e.response?.data || e.message);
        }

        await redis.del(PENDING_PREFIX + jid);
    } else if (!p && tag) {
        console.log(`[TAG] Skipped tagging — no pending order found for ${jid}`);
    }
}

module.exports = { registerPendingOrder, storePollOptions, getPollOptions, handlePollVote };
