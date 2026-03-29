require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const app = express();

// ══════════════════════════════════════════════════════════
// CRITICAL: Capture raw body for HMAC verification
// JSON.stringify(req.body) does NOT match Shopify's HMAC
// because Express parsing can change whitespace/ordering.
// Must use the ORIGINAL raw bytes Shopify sent.
// ══════════════════════════════════════════════════════════
app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));

function verifyWebhook(req, res, next) {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (!hmac) return res.status(401).send('Missing sig');
    const hash = crypto
        .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('base64');
    if (hash !== hmac) {
        console.log('[HMAC] Mismatch — likely a Shopify retry from old deploy. Skipping.');
        return res.status(401).send('Unauthorized');
    }
    next();
}

// ── Health check ──
app.get('/', (_req, res) => res.send(
    '<h2>Bot running</h2><a href="/qr">Scan QR</a> | <a href="/status">Status</a>'
));

// ── QR page ──
app.get('/qr', (_req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>WA Login</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}
img{width:280px;border:4px solid #25D366;border-radius:12px;margin:20px}h2{color:#128C7E}
.ok{color:green;font-size:1.4em}</style></head>
<body><h2>Scan to Connect WhatsApp</h2>
<p>WhatsApp > Linked Devices > Link a Device</p>
<img id="q" src="/qr-image" onerror="this.style.opacity=0.3">
<p id="s">Loading...</p>
<script>
async function tick(){
    try {
        const r=await fetch('/status');const d=await r.json();
        document.getElementById('s').textContent='Status: '+d.status.toUpperCase();
        if(d.status==='connected'){
            document.getElementById('q').style.display='none';
            document.getElementById('s').innerHTML='<b class="ok">✅ Connected!</b>';
        } else {
            document.getElementById('q').src='/qr-image?t='+Date.now();
        }
    } catch(e){}
}
tick();setInterval(tick,4000);
</script></body></html>`);
});

app.get('/qr-image', (_req, res) => {
    const img = require('./whatsapp').getQRImage();
    if (!img) return res.status(404).send('Not ready');
    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(img.replace(/^data:image\/png;base64,/, ''), 'base64'));
});

app.get('/status', (_req, res) => {
    res.json({ status: require('./whatsapp').getConnectionStatus() });
});

// ══════════════════════════════════════════════════════════
// Webhook: New Order
// ══════════════════════════════════════════════════════════
app.post('/webhooks/orders/create', verifyWebhook, async (req, res) => {
    res.sendStatus(200);
    const order = req.body;
    const phone = order.billing_address?.phone || order.shipping_address?.phone || order.phone;
    if (!phone) {
        console.log(`[ORDER] #${order.order_number} — no phone number, skipping`);
        return;
    }

    const isPaid = order.financial_status === 'paid';
    const rec = process.env.ORDER_CONFIRMATION_RECIPIENTS || 'all';
    if (rec === 'cod_only' && isPaid) {
        console.log(`[ORDER] #${order.order_number} — paid order, skipping (COD-only mode)`);
        return;
    }
    if (rec === 'paid_only' && !isPaid) return;

    console.log(`[ORDER] #${order.order_number} — processing for ${phone}`);

    const { sendOrderConfirmation, sendAdminNotification } = require('./whatsapp');
    const { registerPendingOrder } = require('./orderManager');

    if (process.env.ENABLE_ORDER_CONFIRMATION === 'true') {
        try {
            await sendOrderConfirmation(phone, order);
            await registerPendingOrder(phone, order);  // FIX: was missing await
        } catch (e) {
            console.error(`[ORDER] Confirmation failed for #${order.order_number}:`, e.message);
        }
    }

    if (process.env.ADMIN_PHONE) {
        try {
            await sendAdminNotification(process.env.ADMIN_PHONE, order);
        } catch (e) {
            console.error('[ORDER] Admin notification failed:', e.message);
        }
    }
});

// ══════════════════════════════════════════════════════════
// Webhook: Checkout Created (abandoned cart)
// ══════════════════════════════════════════════════════════
app.post('/webhooks/checkouts/create', verifyWebhook, async (req, res) => {
    res.sendStatus(200);
    if (process.env.ENABLE_ABANDONED_CHECKOUT !== 'true') return;

    const co = req.body;
    const phone = co.billing_address?.phone || co.phone;
    if (!phone || !co.abandoned_checkout_url) return;

    const delay = (parseInt(process.env.ABANDONED_CHECKOUT_DELAY_MINUTES) || 30) * 60000;
    console.log(`[CHECKOUT] Scheduled abandoned cart check for ${phone} in ${delay / 60000} min`);

    setTimeout(async () => {
        try {
            const axios = require('axios');
            const r = await axios.get(
                `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/checkouts/${co.token}.json`,
                { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } }
            );
            if (r.data?.checkout?.completed_at) {
                console.log(`[CHECKOUT] Already completed for ${phone}, skipping`);
                return;
            }
        } catch (e) { /* If we can't check, send the message anyway */ }

        const { sendAbandonedCheckout } = require('./whatsapp');
        try {
            await sendAbandonedCheckout(phone, co);
        } catch (e) {
            console.error('[CHECKOUT] Abandoned cart message failed:', e.message);
        }
    }, delay);
});

// ══════════════════════════════════════════════════════════
// Webhook: Order Fulfilled
// ══════════════════════════════════════════════════════════
app.post('/webhooks/orders/fulfilled', verifyWebhook, async (req, res) => {
    res.sendStatus(200);
    const order = req.body;
    const phone = order.billing_address?.phone || order.shipping_address?.phone;
    if (!phone) return;

    const { sendFulfillmentNotification } = require('./whatsapp');
    try {
        await sendFulfillmentNotification(phone, order);
    } catch (e) {
        console.error('[FULFILL] Notification failed:', e.message);
    }
});

// ── Start server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    console.log('[SERVER] Visit /qr to connect WhatsApp');
    require('./whatsapp').getWASocket();
});
