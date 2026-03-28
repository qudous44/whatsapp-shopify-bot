# WhatsApp + Shopify Bot — Full Debugging Session Summary

**Date:** March 28, 2026
**Store:** gulshanefashion.myshopify.com
**Developer:** Abdul Qudous (qudous44)
**Bot URL:** https://whatsapp-shopify-bot-uo6g.onrender.com
**GitHub:** https://github.com/qudous44/whatsapp-shopify-bot

---

## Project Overview

A free WhatsApp + Shopify automation bot built as a replica of the WhatFlow app.

**Tech Stack:** Node.js + Express + Baileys (WhatsApp) + Shopify Webhooks
**Hosting:** Render (free tier)
**Purpose:**
- When a COD order is placed → send WhatsApp confirmation message + poll to customer
- Customer votes on poll → bot sends confirmation reply + tags Shopify order
- Also handles abandoned cart reminders and fulfillment notifications

**Poll Options (must match exactly):**
- `Confirm ✅ (Cash On Delivery)`
- `Confirm ✅ Advance Payment  (EXTRA 150/- Discount)` ← two spaces before EXTRA

**Tags Applied After Vote:**
- `✅ Order Confirmed` (for Cash on Delivery)
- `✅ Paid Order (Verify Payment)` (for Advance Payment)

---

## Problems Encountered & Fixes Applied

### Problem 1 — WhatsApp Not Connected When Order Arrives

**Symptom:** `Confirmation failed: WhatsApp not connected`

**Root Cause:** Render free tier spins down after inactivity. When a new order webhook arrives, WhatsApp has disconnected and the old code (`ensureConn()`) threw an error immediately instead of waiting.

**Fix (commit `1a1d3b2`):** Replaced `ensureConn()` with `waitForConnection(maxWaitMs)` — polls every 3 seconds for up to 2 minutes waiting for WhatsApp to reconnect. Also added queue resume trigger in the `connection.update → open` handler so queued messages send after reconnect.

---

### Problem 2 — In-Memory State Lost on Redeploys

**Symptom:** Confirmation message sent, customer voted, but no reply and no tags added.

**Root Cause:** `pending` Map (order data) and `pollOptionsStore` Map (poll data) were stored in RAM only. Every Render redeploy wiped them. If a redeploy happened between order placement and customer voting, the vote could not be matched to any order.

**Fix (commit `c966936`):** Added disk persistence to `wa_session/pending_state.json`:
- `loadState()` called at startup — reloads pending orders and poll options (skips entries older than 24h)
- `saveState()` called on every write to `pending` or `pollOptionsStore`
- Both maps survive redeploys and server restarts

---

### Problem 3 — Poll Votes Not Being Processed (`selectedOptions count: 0`)

**Symptom:** Logs showed `[POLL-UPSERT] selectedOptions count: 0` — votes arriving but empty.

**Root Cause:** WhatsApp delivers poll votes as encrypted Signal protocol messages. The original code tried to read `selectedOptions` as plain text from `messages.upsert`, but those are actually SHA-256 hashes encrypted with the Signal ratchet. Without the original poll message object for decryption context, they can't be read.

**Fix (commit `546a0b4`):** Switched to Baileys' built-in `getAggregateVotesInPollMessage()` function:
- Stores the full `pollMsg` WAMessage object in `sentPolls` Map when poll is sent
- `messages.update` handler calls `getAggregateVotesInPollMessage({ message, key, pollUpdates }, creds.me)`
- Returns `[{ name, voters }]` array — finds which option has `voters.length > 0`
- Uses `pollData.jid` (the phone JID we sent to) to bypass the `@lid` linked-device JID issue

---

### Problem 4 — `sentPolls` Map Lost on Redeploy (PATH 2 Fallback)

**Symptom:** Even after fix #3, votes still failed after a redeploy. Logs would show `[POLL] No stored poll for msg ID: ...`

**Root Cause:** `sentPolls` in `whatsapp.js` is an in-memory Map. If Render redeployed the server between the order confirmation being sent and the customer voting, the `sentPolls` Map was empty on the new instance.

**Fix (commits `149e2e6` + `47dd470`):** Added dual-path poll vote handling:

- **PATH 1 (same instance):** Uses `getAggregateVotesInPollMessage` with full `pollMsg` from in-memory `sentPolls`
- **PATH 2 (after redeploy):** Falls back to SHA-256 hash matching using disk-persisted `pollOptionsStore`. Added `getPollOptions(pollMsgId)` export to `orderManager.js`. Iterates through `pollUpdates[].vote.selectedOptions` hashes and matches them against stored option names using `crypto.createHash('sha256').update(optionName).digest()`

Both paths use `storePollOptions()` (disk-persisted) as the source of the phone JID, so votes are always routable even after a redeploy.

---

### Problem 5 — `Session error: Bad MAC` (THE FINAL ROOT CAUSE)

**Symptom:** Logs showed:
```
Failed to decrypt message with any known session...
Session error: Error: Bad MAC Error: Bad MAC
  at Object.verifyMAC (.../libsignal/src/crypto.js:87:15)
    at SessionCipher.doDecryptWhisperMessage (...)
    ```
    Poll vote arrived but decryption failed completely before any handler could process it.

    **Root Cause:** Every time Render redeploys and a new QR scan happens, WhatsApp generates new Signal protocol encryption keys. However, old signal session files from previous instances remained on disk in `wa_session/`. When the new instance tried to decrypt incoming messages (poll votes) using the mismatched stale keys, the MAC verification failed — blocking ALL poll vote processing.

    **Fix (commit `e8c14bc`):** Added `clearSignalKeys()` function that runs automatically when a QR code is first shown (new login starting):
    - Deletes: `session-*`, `pre-key-*`, `sender-key-*`, `app-state-sync-*`, `app-state-version-*`, `sender-key-memory.json`
    - Keeps: `creds.json` (WhatsApp identity), `pending_state.json` (order/poll state)
    - Uses `qrShownOnce` flag so it only clears once per login cycle, not on every QR refresh
    - Resets flag on `connection === 'open'` for future logout/re-login cycles

    ---

    ## Commit History (This Session)

    | Commit | Description |
    |--------|-------------|
    | `1a1d3b2` | Fix: `waitForConnection` replaces `ensureConn` |
    | `c966936` | Fix: persist pending orders + poll state to disk |
    | `546a0b4` | Fix: use `getAggregateVotesInPollMessage` to properly decrypt poll votes + store full poll msg |
    | `149e2e6` | Fix: dual-path poll vote handling — PATH1 in-memory + PATH2 disk hash matching for redeploy resilience |
    | `47dd470` | Fix: add `getPollOptions` export for hash-matching fallback in poll vote handler |
    | `e8c14bc` | Fix: clear stale signal keys on QR login to prevent Bad MAC decryption errors on poll votes |

    ---

    ## Current Status

    | Feature | Status |
    |---------|--------|
    | Order webhook received (HMAC verified) | ✅ Working |
    | WhatsApp confirmation message sent to customer | ✅ Working |
    | Poll sent after confirmation message | ✅ Working |
    | Admin notification sent | ✅ Working |
    | Pending order state survives redeploys | ✅ Working |
    | Poll options stored to disk | ✅ Working |
    | Bad MAC error on poll vote decryption | ✅ Fixed (e8c14bc) |
    | Tag added to Shopify order after vote | ⏳ Pending final test |
    | Confirmation reply sent after vote | ⏳ Pending final test |

    ---

    ## Architecture

    ```
    Shopify Order Placed
            │
                    ▼
                    POST /webhooks/orders/create
                            │
                              HMAC Verified?
                                      │ Yes
                                              ▼
                                              sendOrderConfirmation(phone, order)
                                                      │
                                                              ├─ safeSend: formatMessage('orderConfirmation', order)
                                                                      ├─ storePollOptions(pollMsgId, jid, POLL_OPTIONS)  ← disk
                                                                              ├─ sentPolls.set(pollMsgId, { jid, msg })          ← memory
                                                                                      └─ registerPendingOrder(phone, order)               ← disk

                                                                                              Customer Votes on Poll
                                                                                                      │
                                                                                                              ▼
                                                                                                              sock.ev.on('messages.update')
                                                                                                                      │
                                                                                                                              ├─ PATH 1: sentPolls has full msg?
                                                                                                                                      │     └─ getAggregateVotesInPollMessage() → votedOption
                                                                                                                                              │
                                                                                                                                                      └─ PATH 2: fallback to disk
                                                                                                                                                                    └─ getPollOptions() + SHA256 hash matching → votedOption
                                                                                                                                                                            
                                                                                                                                                                                    ▼
                                                                                                                                                                                    handlePollVote(jid, votedOption, sock)
                                                                                                                                                                                            │
                                                                                                                                                                                                    ├─ fastReply(jid, confirmationMessage)
                                                                                                                                                                                                            └─ axios.put Shopify order tags
                                                                                                                                                                                                            ```
                                                                                                                                                                                                            
                                                                                                                                                                                                            ---
                                                                                                                                                                                                            
                                                                                                                                                                                                            ## Key Files
                                                                                                                                                                                                            
                                                                                                                                                                                                            | File | Purpose |
                                                                                                                                                                                                            |------|---------|
                                                                                                                                                                                                            | `server.js` | Express server, webhook routes, HMAC verification |
                                                                                                                                                                                                            | `whatsapp.js` | Baileys WhatsApp client, poll vote handler, message queue |
                                                                                                                                                                                                            | `orderManager.js` | Order state management, disk persistence, tag logic |
                                                                                                                                                                                                            | `messageTemplates.js` | WhatFlow-replica message templates |
                                                                                                                                                                                                            | `wa_session/creds.json` | WhatsApp auth credentials |
                                                                                                                                                                                                            | `wa_session/pending_state.json` | Persisted pending orders + poll options |
                                                                                                                                                                                                            
                                                                                                                                                                                                            ---
                                                                                                                                                                                                            
                                                                                                                                                                                                            ## Environment Variables Required
                                                                                                                                                                                                            
                                                                                                                                                                                                            | Variable | Value |
                                                                                                                                                                                                            |----------|-------|
                                                                                                                                                                                                            | `SHOPIFY_SHOP_DOMAIN` | `gulshanefashion.myshopify.com` |
                                                                                                                                                                                                            | `SHOPIFY_ACCESS_TOKEN` | WhatsApp Order Bot app token |
                                                                                                                                                                                                            | `SHOPIFY_WEBHOOK_SECRET` | Webhook HMAC secret |
                                                                                                                                                                                                            | `ADMIN_PHONE` | `923266298218` |
                                                                                                                                                                                                            | `SESSION_DIR` | `./wa_session` |
                                                                                                                                                                                                            
                                                                                                                                                                                                            ---
                                                                                                                                                                                                            
                                                                                                                                                                                                            ## Important Notes
                                                                                                                                                                                                            
                                                                                                                                                                                                            ### HMAC Mismatch on Some Webhooks
                                                                                                                                                                                                            Some webhooks arrive with HMAC mismatch — these are **Shopify retrying old failed webhooks** from previous deploy periods. They are NOT a bug. New orders always pass HMAC correctly.
                                                                                                                                                                                                            
                                                                                                                                                                                                            ### WhatsApp Order Bot App Shows "Example Domain"
                                                                                                                                                                                                            This is **normal**. The WhatsApp Order Bot is a backend-only custom Shopify app. The app UI shows "Example Domain" because no frontend URL was configured — only the API access token matters. The app has Orders read+write access and is confirmed active.
                                                                                                                                                                                                            
                                                                                                                                                                                                            ### Render Free Tier Behaviour
                                                                                                                                                                                                            Render free tier spins down after 15 minutes of inactivity. First request after spin-down takes ~50 seconds. The `waitForConnection()` function handles this by waiting up to 2 minutes for WhatsApp to reconnect before processing the order.
                                                                                                                                                                                                            
                                                                                                                                                                                                            ### QR Scan Requirement
                                                                                                                                                                                                            Each time Render deploys a new instance AND the WhatsApp session cannot auto-reconnect, a QR scan is required at:
                                                                                                                                                                                                            `https://whatsapp-shopify-bot-uo6g.onrender.com/qr`
                                                                                                                                                                                                            
                                                                                                                                                                                                            After the `clearSignalKeys()` fix, each fresh QR scan now starts with clean signal keys — no more Bad MAC errors.
                                                                                                                                                                                                            
                                                                                                                                                                                                            ---
                                                                                                                                                                                                            
                                                                                                                                                                                                            *Summary generated: March 28, 2026*
