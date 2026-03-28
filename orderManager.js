const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Persist state to disk so redeploys don't lose pending orders/polls
const STATE_FILE = path.join(process.env.SESSION_DIR || './wa_session', 'pending_state.json');

function loadState() {
        try {
                  if (fs.existsSync(STATE_FILE)) {
                              const raw = fs.readFileSync(STATE_FILE, 'utf8');
                              const data = JSON.parse(raw);
                              const now = Date.now();
                              const pending = new Map();
                              const pollOptionsStore = new Map();
                              // Load pending orders (skip expired ones older than 24h)
                    if (data.pending) {
                                  for (const [jid, val] of Object.entries(data.pending)) {
                                                  if (!val.savedAt || now - val.savedAt < 86400000) {
                                                                    pending.set(jid, val);
                                                  }
                                  }
                    }
                              // Load poll options (skip expired)
                    if (data.pollOptionsStore) {
                                  for (const [id, val] of Object.entries(data.pollOptionsStore)) {
                                                  if (!val.savedAt || now - val.savedAt < 86400000) {
                                                                    pollOptionsStore.set(id, val);
                                                  }
                                  }
                    }
                              console.log('[State] Loaded', pending.size, 'pending orders,', pollOptionsStore.size, 'poll entries from disk');
                              return { pending, pollOptionsStore };
                  }
        } catch (e) {
                  console.error('[State] Failed to load state:', e.message);
        }
        return { pending: new Map(), pollOptionsStore: new Map() };
}

function saveState() {
        try {
                  const now = Date.now();
                  const data = {
                              pending: Object.fromEntries(Array.from(pending.entries()).map(([k, v]) => [k, { ...v, savedAt: now }])),
                              pollOptionsStore: Object.fromEntries(Array.from(pollOptionsStore.entries()).map(([k, v]) => [k, { ...v, savedAt: now }]))
                  };
                  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
                  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
                  console.error('[State] Failed to save state:', e.message);
        }
}

const { pending, pollOptionsStore } = loadState();

function toJid(phone) {
        let n = String(phone).replace(/\D/g, '');
        if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
        if (n.startsWith('3') && n.length === 10) n = '92' + n;
        return n + '@s.whatsapp.net';
}

function storePollOptions(pollMsgId, jid, options) {
        pollOptionsStore.set(pollMsgId, { jid, options });
        saveState();
        console.log('[PollStore] Stored options for poll', pollMsgId, ':', options);
        setTimeout(function() { pollOptionsStore.delete(pollMsgId); saveState(); }, 86400000);
}

function findPendingJidForPoll(pollMsgId) {
        if (pollOptionsStore.has(pollMsgId)) {
                  return pollOptionsStore.get(pollMsgId).jid;
        }
        return null;
}

function registerPendingOrder(phone, order) {
        const jid = toJid(phone);
        pending.set(jid, { orderId: order.id, orderNumber: order.order_number, orderName: order.name });
        saveState();
        console.log('[OrderManager] Registered pending order for:', jid, '-> Order #' + order.order_number);
        setTimeout(function() { pending.delete(jid); saveState(); }, 86400000);
}

function hashOption(optionName) {
        return crypto.createHash('sha256').update(optionName).digest();
}

async function handlePollVoteByHash(voterJid, selectedHashes, pollUpdate, sock) {
        try {
                  const pollMsgId = pollUpdate.pollUpdateMessageKey && pollUpdate.pollUpdateMessageKey.id;
                  console.log('[PollVote] Looking up poll options for msg ID:', pollMsgId);
                  let optionName = null;
                  if (pollMsgId && pollOptionsStore.has(pollMsgId)) {
                              const stored = pollOptionsStore.get(pollMsgId);
                              const options = stored.options;
                              console.log('[PollVote] Found stored options:', options);
                              for (let i = 0; i < options.length; i++) {
                                            const optHash = hashOption(options[i]);
                                            for (let j = 0; j < selectedHashes.length; j++) {
                                                            const selBuf = Buffer.isBuffer(selectedHashes[j]) ? selectedHashes[j] : Buffer.from(selectedHashes[j]);
                                                            if (optHash.equals(selBuf)) { optionName = options[i]; break; }
                                            }
                                            if (optionName) break;
                              }
                              if (!optionName && options.length > 0) {
                                            console.log('[PollVote] Hash matching failed - trying index 0 as fallback');
                                            optionName = options[0];
                              }
                  } else {
                              console.log('[PollVote] No stored poll options for', pollMsgId);
                              const { fastReply } = require('./whatsapp');
                              await fastReply(voterJid, 'Shukriya! Aapka jawab receive ho gaya. Hum aapka order process karenge. Gulshan-e-Fashion');
                              return;
                  }
                  if (optionName) {
                              const targetJid = pollOptionsStore.has(pollMsgId) ? pollOptionsStore.get(pollMsgId).jid : voterJid;
                              await handlePollVote(targetJid, optionName, sock);
                  }
        } catch (e) {
                  console.error('[PollVote] Error in handlePollVoteByHash:', e.message);
        }
}

async function handlePollVote(jid, optionName, sock) {
        const opt = (optionName || '').toLowerCase();
        console.log('[OrderManager] Handling vote:', optionName, 'from:', jid);
        const p = pending.get(jid);
        if (!p) {
                  console.log('[OrderManager] No pending order for:', jid, '(map size:', pending.size, ')');
                  console.log('[OrderManager] Current pending JIDs:', Array.from(pending.keys()));
        }

  let replyMsg = '';
        let tag = '';

  if (opt.includes('cash') || (opt.includes('confirm') && !opt.includes('advance') && !opt.includes('150'))) {
            replyMsg = '*Order confirmed!* \uD83D\uDE0A\n\nEstimated delivery in *2-4 working days.*\uD83D\uDCE6\uD83D\uDE9A\n\nAap apna parcel rider ko payment krne se pehle bhi check kar sakte hain! \uD83D\uDCE6\u2728';
            tag = '\u2705 Order Confirmed';
  } else if (opt.includes('advance') || opt.includes('150')) {
            replyMsg = 'Total amount me se Rs.150 kam hamare account me bhej dein. Screenshot share karein. Order process ho jayega.\n\nBank Details:\n\nBank: UBL\n\nTitle: Gulshan e Fashion\n\nAccount No: 2661350931229\n\nIBAN: PK13UNIL0109000350931229\n\nAgar payment receive na hui to order Cash on Delivery (COD) full amount par dispatch hoga.';
            tag = '\u2705 Paid Order (Verify Payment)';
  } else {
            console.log('[OrderManager] Unrecognized vote:', optionName);
            return;
  }

  const { fastReply } = require('./whatsapp');
        await fastReply(jid, replyMsg);
        console.log('[OrderManager] Reply sent, tag:', tag);

  if (p && tag) {
            const h = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };
            const url = 'https://' + process.env.SHOPIFY_SHOP_DOMAIN + '/admin/api/2024-01/orders/' + p.orderId + '.json';
            try {
                        const g = await axios.get(url, { headers: h });
                        const existing = g.data.order.tags || '';
                        const tagList = existing ? existing.split(', ').map(function(t) { return t.trim(); }).filter(Boolean) : [];
                        tagList.push(tag);
                        const updated = Array.from(new Set(tagList)).join(', ');
                        await axios.put(url, { order: { id: p.orderId, tags: updated } }, { headers: h });
                        console.log('[OrderManager] Tagged order #' + p.orderNumber, '->', tag);
                        pending.delete(jid);
                        saveState();
            } catch (e) {
                        console.error('[OrderManager] Tag failed:', e.response && e.response.data || e.message);
            }
  }
}

module.exports = {
        registerPendingOrder,
        handlePollVote,
        handlePollVoteByHash,
        storePollOptions,
        findPendingJidForPoll
};
