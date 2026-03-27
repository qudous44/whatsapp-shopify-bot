require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const app = express();

// Store raw body for HMAC verification
app.use(express.json({
    verify: (req, res, buf) => {
          req.rawBody = buf;
    }
}));

function verifyWebhook(req, res, next) {
    console.log('[WEBHOOK] Received webhook on:', req.path);
    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (!hmac) {
          console.log('[WEBHOOK] Missing HMAC signature');
          return res.status(401).send('Missing sig');
    }
    const hash = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('base64');
    if (hash !== hmac) {
          console.log('[WEBHOOK] HMAC mismatch. Expected:', hmac, 'Got:', hash);
          return res.status(401).send('Unauthorized');
    }
    console.log('[WEBHOOK] HMAC verified OK');
    next();
}

app.get('/', (req, res) => res.send('<h2>Bot running</h2><a href="/qr">Scan QR</a> | <a href="/status">Status</a>'));

app.get('/qr', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>WA Login</title>
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}
        img{width:280px;border:4px solid #25D366;border-radius:12px;margin:20px}h2{color:#128C7E}</style></head>
          <body><h2>Scan to Connect WhatsApp</h2>
            <p>WhatsApp > Linked Devices > Link a Device</p>
              <img id="q" src="/qr-image" onerror="this.style.opacity=0.3">
                <p id="s">Loading...</p>
                  <script>
                    async function tick(){
                        const r=await fetch('/status');const d=await r.json();
                            document.getElementById('s').textContent='Status: '+d.status.toUpperCase();
                                if(d.status==='connected'){document.getElementById('q').style.display='none';
                                    document.getElementById('s').innerHTML='<b style=color:green>Connected!</b>';}
                                        else document.getElementById('q').src='/qr-image?t='+Date.now();
                                          }
                                            tick();setInterval(tick,4000);
                                              </script></body></html>`);
});

app.get('/qr-image', (req, res) => {
    const img = require('./whatsapp').getQRImage();
    if (!img) return res.status(404).send('Not ready');
    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(img.replace(/^data:image\/png;base64,/, ''), 'base64'));
});

app.get('/status', (req, res) => res.json({ status: require('./whatsapp').getConnectionStatus() }));

app.post('/webhooks/orders/create', verifyWebhook, async (req, res) => {
    res.sendStatus(200);
    const order = req.body;
    console.log('[ORDER] New order received:', order.name, 'from', order.billing_address?.phone || order.shipping_address?.phone || order.phone);
    const phone = order.billing_address?.phone || order.shipping_address?.phone || order.phone;
    if (!phone) { console.log('[ORDER] No phone number found, skipping'); return; }

           const isPaid = order.financial_status === 'paid';
    const rec = process.env.ORDER_CONFIRMATION_RECIPIENTS || 'all';
    if (rec === 'cod_only' && isPaid) { console.log('[ORDER] Paid order, COD only mode, skipping'); return; }
    if (rec === 'paid_only' && !isPaid) return;

           const { sendOrderConfirmation, sendAdminNotification } = require('./whatsapp');
    const { registerPendingOrder } = require('./orderManager');

           if (process.env.ENABLE_ORDER_CONFIRMATION === 'true') {
                 console.log('[ORDER] Sending order confirmation to:', phone);
                 await sendOrderConfirmation(phone, order).catch(e => console.error('[ORDER] Send error:', e.message));
                 await registerPendingOrder(phone, order);
           }
    if (process.env.ADMIN_PHONE) {
          console.log('[ORDER] Sending admin notification to:', process.env.ADMIN_PHONE);
          await sendAdminNotification(process.env.ADMIN_PHONE, order).catch(e => console.error('[ORDER] Admin notify error:', e.message));
    }
});

app.post('/webhooks/checkouts/create', verifyWebhook, async (req, res) => {
    res.sendStatus(200);
    if (process.env.ENABLE_ABANDONED_CHECKOUT !== 'true') return;
    const co = req.body;
    const phone = co.billing_address?.phone || co.phone;
    if (!phone || !co.abandoned_checkout_url) return;
    const delay = (parseInt(process.env.ABANDONED_CHECKOUT_DELAY_MINUTES) || 30) * 60000;
    console.log('[CHECKOUT] Abandoned checkout scheduled for', phone, 'in', delay / 60000, 'minutes');
    setTimeout(async () => {
          try {
                  const axios = require('axios');
                  const r = await axios.get(
                            `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/checkouts/${co.token}.json`,
                    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } });
                  if (r.data?.checkout?.completed_at) return;
          } catch (e) {}
          const { sendAbandonedCheckout } = require('./whatsapp');
          await sendAbandonedCheckout(phone, co).catch(console.error);
    }, delay);
});

app.post('/webhooks/orders/fulfilled', verifyWebhook, async (req, res) => {
    res.sendStatus(200);
    const order = req.body;
    const phone = order.billing_address?.phone || order.shipping_address?.phone;
    if (!phone) return;
    console.log('[FULFILLED] Sending fulfillment notification to:', phone);
    const { sendFulfillmentNotification } = require('./whatsapp');
    await sendFulfillmentNotification(phone, order).catch(console.error);
});

app.get('/setup-webhooks', async (req, res) => {
    const axios = require('axios');
    const BASE = process.env.BASE_URL, SHOP = process.env.SHOPIFY_SHOP_DOMAIN, TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!BASE || !SHOP || !TOKEN) return res.send('<h3>Error: Fill in BASE_URL, SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN in environment variables first.</h3>');
    const hooks = [
      { topic: 'orders/create', address: BASE + '/webhooks/orders/create', format: 'json' },
      { topic: 'checkouts/create', address: BASE + '/webhooks/checkouts/create', format: 'json' },
      { topic: 'orders/fulfilled', address: BASE + '/webhooks/orders/fulfilled', format: 'json' },
        ];
    let results = '<h2>Webhook Registration</h2>';
    for (const wh of hooks) {
          try {
                  await axios.post(`https://${SHOP}/admin/api/2024-01/webhooks.json`, { webhook: wh }, { headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' } });
                  results += `<p style="color:green">✅ Registered: ${wh.topic}</p>`;
          } catch (e) {
                  const err = e.response?.data?.errors?.address?.[0] || '';
                  if (err.includes('already')) results += `<p style="color:orange">⚠️ Already exists: ${wh.topic}</p>`;
                  else results += `<p style="color:red">❌ Failed: ${wh.topic} — ${err || e.message}</p>`;
          }
    }
    results += '<br><p><b>Done!</b> Now go to Shopify Admin → Settings → Notifications → Webhooks → copy the Signing secret → add it as SHOPIFY_WEBHOOK_SECRET in Render environment variables.</p>';
    res.send(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Server on port ' + PORT);
    console.log('Visit /qr to connect WhatsApp');
    require('./whatsapp').getWASocket();
});
