const axios = require('axios');
const crypto = require('crypto');

const pending = new Map();
const pollOptionsStore = new Map();

function toJid(phone) {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
  if (n.startsWith('3') && n.length === 10) n = '92' + n;
  return n + '@s.whatsapp.net';
}

function storePollOptions(pollMsgId, jid, options) {
  pollOptionsStore.set(pollMsgId, { jid: jid, options: options });
  console.log('[PollStore] Stored options for poll', pollMsgId, ':', options);
  setTimeout(function() { pollOptionsStore.delete(pollMsgId); }, 86400000);
}

function registerPendingOrder(phone, order) {
  const jid = toJid(phone);
  pending.set(jid, {
    orderId: order.id,
    orderNumber: order.order_number,
    orderName: order.name
  });
  console.log('[OrderManager] Registered pending order for:', jid, '-> Order #' + order.order_number);
  setTimeout(function() { pending.delete(jid); }, 86400000);
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
          if (optHash.equals(selBuf)) {
            optionName = options[i];
            console.log('[PollVote] Matched option:', optionName);
            break;
          }
        }
        if (optionName) break;
      }

      if (!optionName) {
        for (let i = 0; i < options.length; i++) {
          const optHash = hashOption(options[i]).toString('hex');
          for (let j = 0; j < selectedHashes.length; j++) {
            const selHex = Buffer.isBuffer(selectedHashes[j]) ? selectedHashes[j].toString('hex') : Buffer.from(selectedHashes[j]).toString('hex');
            console.log('[PollVote] Comparing', optHash.substring(0,16), 'vs', selHex.substring(0,16));
            if (optHash === selHex) {
              optionName = options[i];
              break;
            }
          }
          if (optionName) break;
        }
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
      await handlePollVote(voterJid, optionName, sock);
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
  }

  let replyMsg = '';
  let tag = '';

  if (opt.includes('cash') || (opt.includes('confirm') && !opt.includes('advance'))) {
    replyMsg = '*Order confirmed!* \uD83D\uDE0A\n\nEstimated delivery in *2-4 working days.*\uD83D\uDCE6\uD83D\uDE9A\n\nAap apna parcel rider ko payment krne se pehle bhi check kar sakte hain! \uD83D\uDCE6\u2728';
    tag = 'Order Confirmed';
  } else if (opt.includes('advance') || opt.includes('150')) {
    replyMsg = 'Total amount me se Rs.150 kam hamare account me bhej dein. Screenshot share karein. Order process ho jayega.\n\nBank Details:\n\nBank: UBL\n\nTitle: Gulshan e Fashion\n\nAccount No: 2661350931229\n\nIBAN: PK13UNIL0109000350931229\n\nAgar payment receive na hui to order Cash on Delivery (COD) full amount par dispatch hoga.';
    tag = 'Paid Order (Verify Payment)';
  } else {
    console.log('[OrderManager] Unrecognized vote:', optionName);
    return;
  }

  // Unescape unicode sequences
  replyMsg = replyMsg.replace(/\\u([0-9A-Fa-f]{4})/g, function(m, hex) { return String.fromCharCode(parseInt(hex, 16)); });

  const { fastReply } = require('./whatsapp');
  await fastReply(jid, replyMsg);
  console.log('[OrderManager] Reply sent, tag:', tag);

  if (p && tag) {
    const h = {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    };
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
    } catch (e) {
      console.error('[OrderManager] Tag failed:', e.response && e.response.data || e.message);
    }
  }
}

module.exports = {
  registerPendingOrder: registerPendingOrder,
  handlePollVote: handlePollVote,
  handlePollVoteByHash: handlePollVoteByHash,
  storePollOptions: storePollOptions
};
