const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_DIR = process.env.SESSION_DIR || './wa_session';
const STATE_FILE = path.join(SESSION_DIR, 'pending_state.json');

// ── In-memory maps (hydrated from disk on startup) ──
const pending = new Map();          // jid → { orderId, orderNumber, timestamp }
const pollOptionsStore = new Map(); // pollMsgId → { jid, options: [...], timestamp }

// ── Disk persistence ──
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const now = Date.now();
    const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

    if (raw.pending) {
      for (const [k, v] of Object.entries(raw.pending)) {
        if (now - (v.timestamp || 0) < MAX_AGE) {
          pending.set(k, v);
        }
      }
    }
    if (raw.pollOptions) {
      for (const [k, v] of Object.entries(raw.pollOptions)) {
        if (now - (v.timestamp || 0) < MAX_AGE) {
          pollOptionsStore.set(k, v);
        }
      }
    }
    console.log(`[STATE] Loaded ${pending.size} pending orders, ${pollOptionsStore.size} poll options from disk`);
  } catch (e) {
    console.error('[STATE] Failed to load state:', e.message);
  }
}

function saveState() {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const data = {
      pending: Object.fromEntries(pending),
      pollOptions: Object.fromEntries(pollOptionsStore)
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[STATE] Failed to save state:', e.message);
  }
}

// Load state on require()
loadState();

// ── Register pending order (called after sending confirmation) ──
function registerPendingOrder(phone, order) {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
  if (n.startsWith('3') && n.length === 10) n = '92' + n;
  const jid = n + '@s.whatsapp.net';

  pending.set(jid, {
    orderId: order.id,
    orderNumber: order.order_number,
    timestamp: Date.now()
  });
  saveState();
  console.log(`[PENDING] Registered order #${order.order_number} for ${jid}`);

  // Auto-cleanup after 24h
  setTimeout(() => {
    if (pending.has(jid)) {
      pending.delete(jid);
      saveState();
    }
  }, 24 * 60 * 60 * 1000);
}

// ── Store poll options to disk (called after sending poll) ──
function storePollOptions(pollMsgId, jid, options) {
  pollOptionsStore.set(pollMsgId, {
    jid,
    options,
    timestamp: Date.now()
  });
  saveState();
  console.log(`[POLL-STORE] Stored poll ${pollMsgId} for ${jid} with ${options.length} options`);
}

// ── Get poll options from disk (used by PATH 2 fallback) ──
function getPollOptions(pollMsgId) {
  return pollOptionsStore.get(pollMsgId) || null;
}

// ── Handle poll vote ──
async function handlePollVote(jid, votedOption, sock) {
  const opt = votedOption.toLowerCase();
  console.log(`[VOTE] Processing vote from ${jid}: "${votedOption}"`);

  // Find pending order for this JID
  const p = pending.get(jid);
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
      console.error(`[TAG] Failed to tag order ${p.orderId}:`, e.message);
    }
    pending.delete(jid);
    saveState();
  }
}

module.exports = {
  registerPendingOrder,
  storePollOptions,
  getPollOptions,
  handlePollVote
};
