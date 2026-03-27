const axios = require('axios');
const pending = new Map();

async function registerPendingOrder(phone, order) {
  let n = String(phone).replace(/\D/g,'');
  if (n.startsWith('03')&&n.length===11) n='92'+n.slice(1);
  if (n.startsWith('3')&&n.length===10) n='92'+n;
  const jid = n+'@s.whatsapp.net';
  pending.set(jid, { orderId: order.id, orderNumber: order.order_number });
  setTimeout(()=>pending.delete(jid), 86400000);
}

async function handlePollVote(jid, option, sock) {
  const opt = option.toLowerCase();
  const p = pending.get(jid);
  let msg='', tag='';

  if (opt.includes('cash') || (opt.includes('confirm')&&!opt.includes('advance'))) {
    msg='✅ *Order Confirmed! (Cash on Delivery)*\n\nShukriya! Aapka order confirm ho gaya hai. 🎉\nDelivery pe courier ko payment karein.\n\n*Gulshan-e-Fashion* 🛍️';
    tag='COD-Confirmed';
  } else if (opt.includes('advance')||opt.includes('150')) {
    msg='💳 *Advance Payment Selected!*\n\nTotal amount me se *Rs.150 kam* hamare account me bhej dein.\nScreenshot share karein — order process ho jayega. ✅\n\n*Bank Details:*\n\n🏦 Bank: UBL\n👤 Title: Gulshan e Fashion\n🔢 Account No: 2661350931229\n🆔 IBAN: PK13UNIL0109000350931229\n\n_Agar payment receive na hui to order COD full amount par dispatch hoga._';
    tag='Paid-Order';
  } else if (opt.includes('cancel')) {
    msg='❌ *Order Cancelled*\n\nAapka order cancel kar diya gaya hai.\n\nDobara order: gulshanefashion.com\n\n*Gulshan-e-Fashion* 😊';
    tag='Cancelled';
  }

  if (msg) await sock.sendMessage(jid, { text: msg }).catch(console.error);
  if (p && tag) {
    const h = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };
    const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/orders/${p.orderId}.json`;
    try {
      const g = await axios.get(url,{headers:h});
      const existing = g.data.order.tags||'';
      const updated = existing ? [...new Set([...existing.split(', '),tag])].join(', ') : tag;
      await axios.put(url,{order:{id:p.orderId,tags:updated}},{headers:h});
      console.log('Tagged order',p.orderId,'->',tag);
    } catch(e){ console.error('Tag failed:',e.message); }
    pending.delete(jid);
  }
}

module.exports = { registerPendingOrder, handlePollVote };