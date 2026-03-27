function formatMessage(type, data) {
  if (type === 'orderConfirmation') {
    const n = data.billing_address?.first_name || data.customer?.first_name || 'Customer';
    const cur = data.currency || 'PKR';
    const items = (data.line_items||[]).map(i=>'  • '+i.name+' x'+i.quantity+' ('+cur+' '+i.price+')').join('\n');
    return 'Hi *'+n+'!* 😊\n\nThis is *Gulshan-e-Fashion* 🛍️\nKindly confirm your recent order.\n\n*Order Details:*\nOrder ID: '+data.id+'\nOrder Number: #'+data.order_number+'\n\n*Items:*\n'+items+'\n\n*Subtotal:* '+cur+' '+data.subtotal_price+'\n*Total:* '+cur+' '+data.total_price+'\n\nYour order will be allowed to open.\n\n*NOTE:*\n_Advance payment pr apko extra Rs.150/- Discount milega._\n\nPlease confirm your order 👇';
  }
  if (type === 'abandonedCheckout') {
    const n = data.billing_address?.first_name || data.email?.split('@')[0] || 'Customer';
    const items = (data.line_items||[]).map(i=>i.title+' x'+i.quantity).join(', ');
    return '🛒 *Order complete nhi hua!* 😟\n\nHi *'+n+'*!\n\nAapka _'+items+'_ wala order ❌ *complete nahi hua*.\n\nFree shipping offer limited time k liey hai!!!\nPlus Aap apna parcel rider ko payment krne se pehle bhi check kar sakte hain! 📦✨\n\nIs link par click karein aur abhi apna order complete karein:\n🔗 '+data.abandoned_checkout_url;
  }
  if (type === 'adminNotification') {
    const items = (data.line_items||[]).map(i=>'  • '+i.name+' x'+i.quantity).join('\n');
    return '🔔 *New Order Alert!*\n\nOrder: #'+data.order_number+'\nCustomer: '+(data.billing_address?.first_name||'')+' '+(data.billing_address?.last_name||'')+'\nPhone: '+(data.billing_address?.phone||data.phone||'N/A')+'\nPayment: '+(data.payment_gateway||'COD').toUpperCase()+'\n\n*Items:*\n'+items+'\n\n*Total: '+(data.currency||'PKR')+' '+data.total_price+'*';
  }
  if (type === 'fulfillment') {
    const n = data.billing_address?.first_name || 'Customer';
    const f = data.fulfillments?.[0];
    return '📦 *Your order is on its way!*\n\nHi *'+n+'*! 😊\n\nYour order *#'+data.order_number+'* has been dispatched! 🚀\n\n🏢 Courier: '+(f?.tracking_company||'N/A')+'\n🔢 Tracking: '+(f?.tracking_number||'N/A')+'\n'+(f?.tracking_url?'🔗 '+f.tracking_url:'')+'\n\nThank you for shopping at *Gulshan-e-Fashion*! 🛍️';
  }
  return '';
}
module.exports = { formatMessage };