# Analytics & Scan Notifications — Design Spec
**Date:** 2026-04-11  
**Project:** ATScore.ai (ats-optimizer-web)  
**Status:** Approved

---

## Overview

Add two capabilities to atscore.ai:

1. **Analytics** — PostHog Cloud (event-level) + Cloudflare Web Analytics (traffic-level)
2. **Discord scan notifications** — Rich embed posted to the ATS Opti-Module channel on every completed scan

---

## Architecture

### PostHog Cloud
- **SDK**: PostHog JS snippet (CDN) loaded in `<head>` of both `public/index.html` and `public/tool/index.html`
- **Server-side events**: Direct `fetch` calls to PostHog's `/capture` API from Cloudflare Functions (no npm package — avoids bundling complexity)
- **Config**: `POSTHOG_API_KEY` and `POSTHOG_HOST` stored as Cloudflare Pages secrets
- **Autocapture**: ON by default (tracks clicks, form submissions, pageviews automatically)

### Cloudflare Web Analytics
- Enabled via Cloudflare dashboard on the Pages project (one click)
- Script tag added to `<head>` of both pages
- Provides: visitors, referrers, countries, device types — separate from PostHog

### Discord Webhook
- Webhook URL for channel `1488368518566252724` stored as `DISCORD_WEBHOOK_URL` Cloudflare Pages secret
- Called from `functions/analyze.js` after Airtable write, best-effort (never blocks scan response)

---

## Events Plan

### Client-side (PostHog JS)

| Event | File | Trigger | Properties |
|---|---|---|---|
| `resume_uploaded` | `public/tool/index.html` | File drop/select | `file_type` (pdf/docx) |
| `scan_submitted` | `public/tool/index.html` | Analyze button click | `has_job_description` (bool), `plan` |
| `scan_completed` | `public/tool/index.html` | Results render | `score`, `grade`, `plan` |
| `paywall_shown` | `public/tool/index.html` | Paywall modal open | `trigger` (hidden_issues/rewrite_cta/upgrade_btn) |
| `upgrade_clicked` | `public/tool/index.html` | Plan selected in paywall | `plan` (single/starter/pro) |
| `rewrite_requested` | `public/tool/index.html` | Download Optimized Resume clicked | `plan` |
| `video_coaching_clicked` | `public/tool/index.html` | Video coaching CTA clicked | — |

**PII rule**: No email, name, or other PII in `capture()` properties. PII goes only in `posthog.identify()`.

**User identification**: Call `posthog.identify(distinctId, { plan })` when the user submits a scan with an email. Use the PostHog anonymous distinct ID as the correlation key passed via `X-POSTHOG-DISTINCT-ID` header to server-side calls.

### Server-side (PostHog `/capture` API via fetch)

| Event | File | Trigger | Properties |
|---|---|---|---|
| `payment_completed` | `functions/stripe-webhook.js` | `checkout.session.completed` | `plan`, `amount_cents` |
| `subscription_cancelled` | `functions/stripe-webhook.js` | `customer.subscription.deleted` | — |

---

## Discord Notification Design

### Trigger
Fires in `functions/analyze.js` after `captureAirtableLead()` succeeds (best-effort, wrapped in try/catch).

### Repeat User Detection
On each scan with an email:
- Check KV for key `seen:{email_hash}` (SHA-256 of lowercased email, hex-encoded)
- If missing: write it (TTL: 90 days), flag as new user
- If present: flag as repeat user

### Embed Format
```
🔍 New Scan — Grade {grade} | Score {score}/100

Plan:        {free|single|starter|pro}
Email:       {email or "anonymous"}
Job Match:   ✅ yes / ❌ no
Model:       {model used}
Repeat user: ✅ yes / 🆕 first scan
Time:        {date/time ET}

[View in Airtable →]  (links to https://airtable.com/appJkfL4EoaSxq8GC/tblxDbnavxmdWozc5)
```

### Failure Handling
Discord webhook failure is logged via `console.warn` and silently swallowed — same pattern as existing email/Airtable best-effort calls.

---

## Files Changed

| File | Change |
|---|---|
| `public/index.html` | Add PostHog JS snippet + Cloudflare Web Analytics script in `<head>` |
| `public/tool/index.html` | Add PostHog JS snippet + Cloudflare Web Analytics script in `<head>`; instrument 7 client-side events |
| `functions/analyze.js` | Add `sendDiscordNotification()` helper; call after Airtable write; add KV repeat-user check; add `payment_completed` PostHog server-side event |
| `functions/stripe-webhook.js` | Add PostHog server-side events for `payment_completed` and `subscription_cancelled` |

---

## Environment Variables Required

| Variable | Where to set | Description |
|---|---|---|
| `POSTHOG_API_KEY` | Cloudflare Pages secrets | PostHog project API key |
| `POSTHOG_HOST` | Cloudflare Pages secrets | PostHog host (e.g. `https://us.i.posthog.com`) |
| `DISCORD_WEBHOOK_URL` | Cloudflare Pages secrets | Discord webhook URL for channel 1488368518566252724 |

---

## Out of Scope

- Cloudflare Web Analytics script tag installation (done manually in Cloudflare dashboard — zero code change)
- Custom PostHog dashboards (built post-deploy in PostHog UI)
- Notifications for events other than scan completion (sales notifications already handled via email in stripe-webhook.js)
