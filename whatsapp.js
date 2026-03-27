const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { formatMessage } = require('./messageTemplates');

let sock = null, qrImg = null, status = 'disconnected';

async function getWASocket() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.SESSION_DIR || './wa_session');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    printQRInTerminal: true,
    browser: ['WA-Shopify-Bot', 'Chrome', '1.0.0'],
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrImg = await QRCode.toDataURL(qr); status = 'qr_ready'; console.log('QR ready at /qr'); }
    if (connection === 'open') { status = 'connected'; qrImg = null; console.log('WhatsApp Connected!'); }
    if (connection === 'close') {
      status = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(getWASocket, 5000);
      else console.log('Logged out. Re-scan QR.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const pollUpdate = msg.message?.pollUpdateMessage;
      if (pollUpdate) {
        const sel = pollUpdate.vote?.selectedOptions?.[0];
        if (sel) { const { handlePollVote } = require('./orderManager'); await handlePollVote(msg.key.remoteJid, sel, sock); }
      }
    }
  });
  return sock;
}

function toJid(phone) {
  let n = String(phone).replace(/\D/g,'');
  if (n.startsWith('03') && n.length===11) n = '92'+n.slice(1);
  if (n.startsWith('3') && n.length===10) n = '92'+n;
  return n+'@s.whatsapp.net';
}
function ensureConn() { if (status!=='connected') throw new Error('WA not connected'); }

async function sendOrderConfirmation(phone, order) {
  ensureConn();
  const jid = toJid(phone);
  await sock.sendMessage(jid, { text: formatMessage('orderConfirmation', order) });
  await sock.sendMessage(jid, {
    poll: {
      name: 'Please confirm your order:',
      values: ['Confirm (Cash On Delivery)', 'Confirm Advance Payment  (EXTRA Rs.150/- Discount)', 'Cancel Order'],
      selectableCount: 1
    }
  });
  console.log('Confirmation sent to', phone);
}

async function sendAbandonedCheckout(phone, checkout) {
  ensureConn();
  await sock.sendMessage(toJid(phone), { text: formatMessage('abandonedCheckout', checkout) });
  console.log('Abandoned cart sent to', phone);
}

async function sendAdminNotification(phone, order) {
  ensureConn();
  await sock.sendMessage(toJid(phone), { text: formatMessage('adminNotification', order) });
}

async function sendFulfillmentNotification(phone, order) {
  ensureConn();
  await sock.sendMessage(toJid(phone), { text: formatMessage('fulfillment', order) });
  console.log('Fulfillment sent to', phone);
}

module.exports = { getWASocket, sendOrderConfirmation, sendAbandonedCheckout, sendAdminNotification, sendFulfillmentNotification, getQRImage: ()=>qrImg, getConnectionStatus: ()=>status };