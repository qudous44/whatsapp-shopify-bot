const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// ── Upstash Redis client (persists across Render restarts/redeploys) ──
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PENDING_PREFIX = 'pending:';
const POLL_PREFIX = 'poll:';
const TTL = 24 * 60 * 60; // 24 hours in seconds

// ── Phone number → WhatsApp JID ──
function toJid(phone) {
    let n = String(phone).replace(/\D/g, '');
    if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
    if (n.startsWith('3') && n.length === 10) n = '92' + n;
    return n + '@s.whatsapp.net';
}

// ── Register pending order (called after sending confirmation) ──
async function registerPendingOrder(phone, order) {
    const jid = toJid(phone);
    await redis.set(
          PENDING_PREFIX + jid,
      { orderId: order.id, orderNumber: order.order_number, timestamp: Date.now() },
      { ex: TTL }
        );
    console.log(`[PENDING] Registered order #${order.order_number} for ${jid}`);
}

// ── Store poll options to Redis (called after sending poll) ──
async function storePollOptions(pollMsgId, jid, options) {
    await redis.set(
          POLL_PREFIX + pollMsgId,
      { jid, options, timestamp: Date.now() },
      { ex: TTL }
        );
    console.log(`[POLL-STORE] Stored poll ${pollMsgId} for ${jid} with ${options.length} options`);
}

// ── Get poll options from Redis (used by PATH 2 fallback) ──
async function getPollOptions(pollMsgId) {
    return await redis.get(POLL_PREFIX + pollMsgId);
}

// ── Handle poll vote ──
async function handlePollVote(jid, votedOption, sock) {
    const opt = votedOption.toLowerCase();
    console.log(`[VOTE] Processing vote from ${jid}: "${votedOption}"`);

  // Find pending order for this JID
  const p = await redis.get(PENDING_PREFIX + jid);
    if (!p) {
          console.log(`[VOTE] No pending order found for ${jid} — may have expired or already processed`);
    }

  let msg = '', tag = '';

  if (opt.includes('cash') || (opt.includes('confirm') && !opt.includes('advance'))) {
        msg = '✅ *Order Confirmed! (Cash on Delivery)*\n\nShukriya! Aapka order confirm ho gaya hai. 🎉\nDelivery pe courier ko payment karein.\n\n*Gulshan-e-Fashion* 🛍️';
        tag = '✅ Order Confirmed';
  } else if (opt.includes('advance') || opt.includes('150')) {
        msg = '💳 *Advance Payment Selected!*\n\nTotal amount me se *Rs.150 kam* hamare account me bhej dein.\nScreenshot share karein — order process ho jayega. ✅\n\n*Bank Details:*\n\n🏦 Bank: UBL\n👤 Title: Gulshan e Fashion\n🔢 Account No: 2661350931229\n🆔 IBAN: PK13UNIL0109000350931229\n\n_Agar payment receive na hui to order COD full amount par dispatch hoga._';
        tag = '✅ Paid Order (Verify Payment)';
  } else if (opt.includes('cancel')) {
        msg = '❌ *Order Cancelled*\n\nAapka order cancel kar diya gaya hai.\n\nDobara order: gulshanefashion.com\n\n*Gulshan-e-Fashion* 😊';
        tag = 'Cancelled';
  }

  // Send reply message
  if (msg) {
        try {
                await sock.sendMessage(jid, { text: msg });
                console.log(`[VOTE] Reply sent to ${jid}`);
        } catch (e) {
                console.error(`[VOTE] Failed to send reply to ${jid}:`, e.message);
        }
  }

  // Tag Shopify order
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
                console.error(`[TAG] Failed to tag order ${p.orderId}:`, e.response?.data || e.message);
        }
        await redis.del(PENDING_PREFIX + jid);
  }
}

module.exports = { registerPendingOrder, storePollOptions, getPollOptions, handlePollVote };
