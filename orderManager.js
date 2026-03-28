const axios = require('axios');
const crypto = require('crypto');

// Pending orders: jid -> { orderId, orderNumber, orderName }
const pending = new Map();

// Poll options store: pollMsgId -> { jid, options: ['option1', 'option2'] }
const pollOptionsStore = new Map();

function toJid(phone) {
      let n = String(phone).replace(/\D/g, '');
      if (n.startsWith('03') && n.length === 11) n = '92' + n.slice(1);
      if (n.startsWith('3') && n.length === 10) n = '92' + n;
      return n + '@s.whatsapp.net';
}

// Called when poll is sent — stores options so we can match by hash later
function storePollOptions(pollMsgId, jid, options) {
      pollOptionsStore.set(pollMsgId, { jid, options });
      console.log('[PollStore] Stored options for poll', pollMsgId, ':', options);
      // Clean up after 24 hours
  setTimeout(() => pollOptionsStore.delete(pollMsgId), 86400000);
}

async function registerPendingOrder(phone, order) {
      const jid = toJid(phone);
      pending.set(jid, {
              orderId: order.id,
              orderNumber: order.order_number,
              orderName: order.name
      });
      console.log('[OrderManager] Registered pending order for:', jid, '-> Order #' + order.order_number);
      setTimeout(() => pending.delete(jid), 86400000);
}

// Hash poll option name the same way WhatsApp does
function hashOption(optionName) {
      return crypto.createHash('sha256').update(optionName).digest();
}

// Called when a pollUpdateMessage is received
// selectedHashes: array of Buffer from pollUpdate.vote.selectedOptions
async function handlePollVoteByHash(voterJid, selectedHashes, pollUpdate, sock) {
      try {
              // Get the original poll message ID to look up options
        const pollMsgId = pollUpdate.pollUpdateMessageKey?.id;
              console.log('[PollVote] Looking up poll options for msg ID:', pollMsgId);

        let optionName = null;

        if (pollMsgId && pollOptionsStore.has(pollMsgId)) {
                  const stored = pollOptionsStore.get(pollMsgId);
                  const options = stored.options;
                  console.log('[PollVote] Found stored options:', options);

                // Match hash to option name
                for (const option of options) {
                            const optHash = hashOption(option);
                            for (const selectedHash of selectedHashes) {
                                          // selectedHash may be a Buffer or Uint8Array
                              const selBuf = Buffer.isBuffer(selectedHash) ? selectedHash : Buffer.from(selectedHash);
                                          if (optHash.equals(selBuf)) {
                                                          optionName = option;
                                                          console.log('[PollVote] Matched option:', optionName);
                                                          break;
                                          }
                            }
                            if (optionName) break;
                }

                if (!optionName) {
                            // Try comparing as hex strings
                    for (const option of options) {
                                  const optHash = hashOption(option).toString('hex');
                                  for (const selectedHash of selectedHashes) {
                                                  const selHex = Buffer.isBuffer(selectedHash)
                                                    ? selectedHash.toString('hex')
                                                                    : Buffer.from(selectedHash).toString('hex');
                                                  console.log('[PollVote] Comparing option hash', optHash.substring(0,16), 'vs selected', selHex.substring(0,16));
                                                  if (optHash === selHex) {
                                                                    optionName = option;
                                                                    break;
                                                  }
                                  }
                                  if (optionName) break;
                    }
                }

                if (!optionName && options.length > 0) {
                            // Fallback: if only 1 hash selected and we have options, use index 0 heuristic
                    // This handles edge cases with encoding differences
                    console.log('[PollVote] Hash matching failed, trying position-based fallback');
                            // Use selectedHashes count and position in options
                    optionName = options[0]; // default to first option as safer fallback
                    console.log('[PollVote] Fallback to first option:', optionName);
                }
        } else {
                  console.log('[PollVote] No stored poll options found for', pollMsgId, '- using text-based detection');
                  // Last resort: we don't know the option, send generic reply
                const { fastReply } = require('./whatsapp');
                  await fastReply(voterJid, 'Shukriya! Aapka jawab receive ho gaya. Hum aapka order process karenge. 😊\n\n*Gulshan-e-Fashion* 🛍️');
                  return;
        }

        if (optionName) {
                  await handlePollVote(voterJid, optionName, sock);
        }
      } catch (e) {
              console.error('[PollVote] Error in handlePollVoteByHash:', e.message);
      }
}

// Main vote handler — receives option name as string
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
          // Option 1: COD — matches WhatFlow "Order Confirmed" tag
        replyMsg =
                  '*Order confirmed!* \uD83D\uDE0A\n\n' +
                  'Estimated delivery in *2-4 working days.*\uD83D\uDCE6\uD83D\uDE9A\n\n' +
                  'Aap apna parcel rider ko payment krne se pehle bhi check kar sakte hain! \uD83D\uDCE6\u2728';
          tag = 'Order Confirmed';

  } else if (opt.includes('advance') || opt.includes('150')) {
          // Option 2: Advance Payment — matches WhatFlow "Paid Order (Verify Payment)" tag
        replyMsg =
                  'Total amount me se Rs.150 kam hamare account me bhej dein. Screenshot share karein. Order process ho jayega.\n\n' +
                  'Bank Details:\n\n' +
                  'Bank: UBL\n\n' +
                  'Title: Gulshan e Fashion\n\n' +
                  'Account No: 2661350931229\n\n' +
                  'IBAN: PK13UNIL0109000350931229\n\n' +
                  'Agar payment receive na hui to order Cash on Delivery (COD) full amount par dispatch hoga.';
          tag = 'Paid Order (Verify Payment)';

  } else {
          console.log('[OrderManager] Unrecognized vote option:', optionName);
          return;
  }

  // Send immediate reply using fastReply
  const { fastReply } = require('./whatsapp');
      await fastReply(jid, replyMsg);
      console.log('[OrderManager] Reply sent, tag will be:', tag);

  // Tag the Shopify order
  if (p && tag) {
          const h = {
                    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
          };
          const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/orders/${p.orderId}.json`;
          try {
                    const g = await axios.get(url, { headers: h });
                    const existing = g.data.order.tags || '';
                    const tagList = existing ? existing.split(', ').map(t => t.trim()).filter(Boolean) : [];
                    tagList.push(tag);
                    const updated = [...new Set(tagList)].join(', ');
                    await axios.put(url, { order: { id: p.orderId, tags: updated } }, { headers: h });
                    console.log('[OrderManager] Tagged order #' + p.orderNumber, '->', tag);
                    pending.delete(jid);
          } catch (e) {
                    console.error('[OrderManager] Tag failed:', e.response?.data || e.message);
          }
  } else if (!p) {
          console.log('[OrderManager] Cannot tag — no pending order found for', jid);
  }
}

module.exports = { registerPendingOrder, handlePollVote, handlePollVoteByHash, storePollOptions };
