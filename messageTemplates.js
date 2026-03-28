function formatMessage(type, data) {
      if (type === 'orderConfirmation') {
                const n = data.billing_address?.first_name || data.customer?.first_name || 'Customer';
                const cur = data.currency || 'PKR';
                const items = (data.line_items||[]).map(i => '*' + i.name + '* x' + i.quantity).join('\n');
                return 'Hi *' + n + '!* \uD83D\uDE0A\n\nThis is *Gulshan-e-Fashion!* \uD83D\uDECD\uFE0F\nKindly confirm your recent order.\n\n*Order Details:*\n\nOrder ID: ' + data.id + '\nOrder Number: #' + data.order_number + '\n\n*Items:*\n' + items + '\n*Subtotal:* ' + cur + ' ' + data.subtotal_price + '\n\nYour order will be allowed to open.\n\n*NOTE:*\n*Advance payment pr apko extra Rs.150/-  Discount milega.*\n\nPlease confirm your order.';
      }
      if (type === 'abandonedCheckout') {
                const n = data.billing_address?.first_name || data.email?.split('@')[0] || 'Customer';
                const items = (data.line_items||[]).map(i => i.title + ' x' + i.quantity).join(', ');
                return '\uD83D\uDED2 *Order complete nhi hua!* \uD83D\uDE1F\n\nHi *' + n + '*!\n\nAapka _' + items + '_ wala order \u274C *complete nahi hua*.\n\nFree shipping offer limited time k liey hai!!!\nPlus Aap apna parcel rider ko payment krne se pehle bhi check kar sakte hain! \uD83D\uDCE6\u2728\n\nIs link par click karein aur abhi apna order complete karein:\n\uD83D\uDD17 ' + data.abandoned_checkout_url;
      }
      if (type === 'adminNotification') {
                const items = (data.line_items||[]).map(i => ' \u2022 ' + i.name + ' x' + i.quantity).join('\n');
                return '\uD83D\uDD14 *New Order Alert!*\n\nOrder: #' + data.order_number + '\nCustomer: ' + (data.billing_address?.first_name || '') + ' ' + (data.billing_address?.last_name || '') + '\nPhone: ' + (data.billing_address?.phone || data.phone || 'N/A') + '\nPayment: ' + (data.payment_gateway || 'COD').toUpperCase() + '\n\n*Items:*\n' + items + '\n\n*Total: ' + (data.currency || 'PKR') + ' ' + data.total_price + '*';
      }
      if (type === 'fulfillment') {
                const n = data.billing_address?.first_name || 'Customer';
                const f = data.fulfillments?.[0];
                return '\uD83D\uDCE6 *Your order is on its way!*\n\nHi *' + n + '*! \uD83D\uDE0A\n\nYour order *#' + data.order_number + '* has been dispatched! \uD83D\uDE80\n\n\uD83C\uDFE2 Courier: ' + (f?.tracking_company || 'N/A') + '\n\uD83D\uDD22 Tracking: ' + (f?.tracking_number || 'N/A') + '\n' + (f?.tracking_url ? '\uD83D\uDD17 ' + f.tracking_url : '') + '\n\nThank you for shopping at *Gulshan-e-Fashion*! \uD83D\uDECD\uFE0F';
      }
      return '';
}
module.exports = { formatMessage };
