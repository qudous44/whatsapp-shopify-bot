const axios = require('axios');

// Stores pending orders: jid -> { orderId, orderNumber, orderName }
const pending = new Map();

function toJid(phone) {
    let n = String(phone).replace(/\D/g, '');
    if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
    if (n.startsWith('3') && n.length === 10) n = '92' + n;
    return n + '@s.whatsapp.net';
}

async function registerPendingOrder(phone, order) {
    const jid = toJid(phone);
    pending.set(jid, {
          orderId: order.id,
          orderNumber: order.order_number,
          orderName: order.name
    });
    console.log('[OrderManager] Registered pending order for:', jid, '-> Order #' + order.order_number);
    // Auto-expire after 24 hours
  setTimeout(() => pending.delete(jid), 86400000);
}

async function handlePollVote(jid, optionName, sock) {
    const opt = (optionName || '').toLowerCase();
    console.log('[OrderManager] Handling vote:', opt, 'from:', jid);

  const p = pending.get(jid);
    if (!p) {
          console.log('[OrderManager] No pending order for:', jid, '(map has', pending.size, 'entries)');
          // Still send a generic reply
      const { fastReply } = require('./whatsapp');
          await fastReply(jid, 'Shukriya! Agar koi masla ho to humse rabta karein. 😊\n\n*Gulshan-e-Fashion* 🛍️');
          return;
    }

  console.log('[OrderManager] Found pending order #' + p.orderNumber + ' for:', jid);

  let replyMsg = '';
    let tag = '';

  if (opt.includes('cash') || (opt.includes('confirm') && !opt.includes('advance'))) {
        replyMsg =
                '✅ *Order Confirmed! (Cash on Delivery)*\n\n' +
                'Shukriya *' + (p.orderName || ('#' + p.orderNumber)) + '*! Aapka order confirm ho gaya hai. 🎉\n\n' +
                '📦 Delivery pe courier ko payment karein.\n' +
                '🚚 2-5 working days mein deliver hoga.\n\n' +
                'Koi sawal ho to humse rabta karein!\n\n' +
                '*Gulshan-e-Fashion* 🛍️';
        tag = 'COD-Confirmed';

  } else if (opt.includes('advance') || opt.includes('150')) {
        replyMsg =
                '💳 *Advance Payment Selected!*\n\n' +
                'Bohat Shukriya! Aapko *Rs.150 extra discount* milega! 🎉\n\n' +
                'Total amount mein se Rs.150 kam karke hamare account mein bhej dein:\n\n' +
                '🏦 *Bank:* UBL\n' +
                '👤 *Title:* Gulshan e Fashion\n' +
                '🔢 *Account No:* 2661350931229\n' +
                '🆔 *IBAN:* PK13UNIL0109000350931229\n\n' +
                'Payment ka screenshot is number par bhej dein — order process ho jayega. ✅\n\n' +
                '_Agar payment receive na hui to order COD full amount par dispatch hoga._\n\n' +
                '*Gulshan-e-Fashion* 🛍️';
        tag = 'Paid-Order';

  } else if (opt.includes('cancel')) {
        replyMsg =
                '❌ *Order Cancelled*\n\n' +
                'Aapka order cancel kar diya gaya hai.\n\n' +
                'Agar dobara order karna chahein:\n' +
                '🌐 gulshanefashion.com\n\n' +
                'Hum aapki khidmat ke liye hamesha haazir hain! 😊\n\n' +
                '*Gulshan-e-Fashion* 🛍️';
        tag = 'Cancelled';
  } else {
        console.log('[OrderManager] Unrecognized vote option:', optionName);
        return;
  }

  // Send immediate reply using fastReply (bypasses queue for instant response)
  const { fastReply } = require('./whatsapp');
    await fastReply(jid, replyMsg);
    console.log('[OrderManager] Reply sent for vote:', tag);

  // Tag the Shopify order
  if (tag) {
        const h = {
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
        };
        const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/orders/${p.orderId}.json`;
        try {
                const g = await axios.get(url, { headers: h });
                const existing = g.data.order.tags || '';
                const tagList = existing ? existing.split(', ').map(t => t.trim()) : [];
                tagList.push(tag);
                const updated = [...new Set(tagList)].join(', ');
                await axios.put(url, { order: { id: p.orderId, tags: updated } }, { headers: h });
                console.log('[OrderManager] Tagged order #' + p.orderNumber, '->', tag);
        } catch (e) {
                console.error('[OrderManager] Tag failed:', e.response?.data || e.message);
        }
        pending.delete(jid);
  }
}

module.exports = { registerPendingOrder, handlePollVote };
