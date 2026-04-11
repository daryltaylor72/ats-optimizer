# Analytics & Discord Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up PostHog analytics, Cloudflare Web Analytics, and Discord scan notifications for atscore.ai.

**Architecture:** The PostHog wizard already added the JS snippet and most client-side events. Remaining work is: one missing client-side event (`scan_submitted`), Discord webhook notification on scan completion (with repeat-user detection via KV), server-side PostHog events for payments, and wiring secrets into GitHub Actions and Cloudflare.

**Tech Stack:** PostHog JS (CDN snippet already in place), PostHog `/capture` API (fetch, server-side), Discord webhook (fetch), Cloudflare KV (existing `TOKENS_KV` binding), Cloudflare Web Analytics (script tag), GitHub Actions secrets, Cloudflare Pages secrets.

---

## Context: What the PostHog Wizard Already Did

The wizard ran and made these changes (not yet committed):
- Created `public/js/posthog-init.js` with CDN snippet — uses `__POSTHOG_PROJECT_TOKEN__` and `__POSTHOG_HOST__` placeholders
- Added `<script src="/js/posthog-init.js"></script>` to `public/index.html` and `public/tool/index.html`
- Added GitHub Actions step to inject tokens via `sed` at deploy time (`.github/workflows/deploy.yml`)
- Instrumented in `public/tool/index.html`: `resume_file_selected`, `resume_analyzed` (with `posthog.identify`), `rewrite_requested`, `rewrite_downloaded`, `paywall_viewed`, `checkout_started`, `recovery_email_sent`, `coupon_redeemed`, `video_review_requested`
- Added `checkout_started` event to `public/index.html`

**Missing:** `scan_submitted` event, Discord notification, repeat-user detection, server-side PostHog events, Cloudflare Web Analytics script tag.

---

## Files

| File | Change |
|---|---|
| `public/tool/index.html` | Add `scan_submitted` event before the `/analyze` fetch |
| `public/index.html` | Add Cloudflare Web Analytics script tag |
| `public/tool/index.html` | Add Cloudflare Web Analytics script tag |
| `functions/analyze.js` | Add `sendDiscordNotification()`, repeat-user KV check, call both after Airtable write |
| `functions/stripe-webhook.js` | Add PostHog server-side `payment_completed` and `subscription_cancelled` events |

---

## Task 1: Add `scan_submitted` event to tool/index.html

**Files:**
- Modify: `public/tool/index.html` (around line 1404 — just before the `fetch('/analyze', ...)` call)

- [ ] **Step 1: Open tool/index.html and find the analyze function's fetch call**

Search for `const res = await fetch('/analyze',` — it's around line 1412.

- [ ] **Step 2: Add scan_submitted capture before the fetch**

Add immediately before `const res = await fetch('/analyze', { method: 'POST', body: fd });`:

```javascript
      posthog.capture('scan_submitted', {
        has_job_description: !!jdInput.value.trim(),
        file_type: selectedFile ? selectedFile.name.split('.').pop().toLowerCase() : 'unknown',
        plan: localStorage.getItem('ats_token') ? 'paid' : 'free',
      });
```

- [ ] **Step 3: Verify the event list in .posthog-events.json is still accurate**

No changes needed — `scan_submitted` was already listed there.

- [ ] **Step 4: Commit**

```bash
cd /Users/daryltaylor/Projects/ats-optimizer-web
git add public/tool/index.html
git commit -m "feat: add scan_submitted posthog event"
```

---

## Task 2: Add Cloudflare Web Analytics script tags

**Files:**
- Modify: `public/index.html` (in `<head>`, after the existing PostHog script tag)
- Modify: `public/tool/index.html` (in `<head>`, after the existing PostHog script tag)

**Prerequisite:** Enable Cloudflare Web Analytics in the Cloudflare dashboard first:
1. Go to Cloudflare dashboard → your `atscore.ai` zone
2. **Analytics & Logs → Web Analytics**
3. Click **Add site** → select `atscore.ai`
4. Copy the `<script>` snippet they give you — it looks like:
   ```html
   <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "YOUR_TOKEN"}'></script>
   ```

- [ ] **Step 1: Get the Cloudflare Web Analytics snippet from the dashboard (manual)**

This is a manual step. Copy the snippet from the Cloudflare dashboard.

- [ ] **Step 2: Add the snippet to public/index.html**

Add immediately after `<script src="/js/posthog-init.js"></script>` in the `<head>`:

```html
  <!-- Cloudflare Web Analytics -->
  <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "YOUR_CF_TOKEN_HERE"}'></script>
```

(Replace `YOUR_CF_TOKEN_HERE` with the actual token from the dashboard.)

- [ ] **Step 3: Add the same snippet to public/tool/index.html**

Add immediately after `<script src="/js/posthog-init.js"></script>` in the `<head>`:

```html
  <!-- Cloudflare Web Analytics -->
  <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "YOUR_CF_TOKEN_HERE"}'></script>
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/tool/index.html
git commit -m "feat: add Cloudflare Web Analytics to landing and tool pages"
```

---

## Task 3: Add Discord notification and repeat-user detection to analyze.js

**Files:**
- Modify: `functions/analyze.js`

The Discord notification fires after `captureAirtableLead()`. It includes: grade, score, plan, email, job match mode, AI model used, repeat-user flag, and a link to the Airtable table.

Repeat-user detection: SHA-256 hash the lowercased email, check/set `seen:{hash}` in `TOKENS_KV` (TTL: 90 days).

- [ ] **Step 1: Add the sendDiscordNotification helper function to analyze.js**

Add this function near the bottom of the file, after `captureAirtableLead`:

```javascript
async function hashEmail(email) {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isRepeatUser(kv, email) {
  if (!kv || !email) return false;
  const hash = await hashEmail(email);
  const key = `seen:${hash}`;
  const existing = await kv.get(key);
  if (!existing) {
    await kv.put(key, '1', { expirationTtl: 90 * 24 * 3600 });
    return false;
  }
  return true;
}

async function sendDiscordNotification(webhookUrl, { email, plan, score, grade, jobMatch, model, isRepeat }) {
  const gradeEmoji = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' }[grade] || '⚪';
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const airtableUrl = 'https://airtable.com/appJkfL4EoaSxq8GC/tblxDbnavxmdWozc5';

  const embed = {
    title: `${gradeEmoji} New Scan — Grade ${grade} | Score ${score}/100`,
    color: score >= 80 ? 0x22c55e : score >= 60 ? 0xf59e0b : 0xef4444,
    fields: [
      { name: 'Plan',        value: plan || 'free',                        inline: true },
      { name: 'Email',       value: email || 'anonymous',                  inline: true },
      { name: 'Job Match',   value: jobMatch ? '✅ yes' : '❌ no',          inline: true },
      { name: 'Model',       value: model || 'unknown',                    inline: true },
      { name: 'Repeat User', value: isRepeat ? '✅ yes' : '🆕 first scan', inline: true },
      { name: 'Time (ET)',   value: timestamp,                             inline: true },
    ],
    footer: { text: `View in Airtable → ${airtableUrl}` },
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
}
```

- [ ] **Step 2: Find where the model name is captured in analyze.js**

Search for the variable that holds the model name used — it's set during the Claude API call. Look for something like `model:` in the response or a variable like `usedModel`. Note the variable name for Step 3.

Run:
```bash
grep -n "model\|usedModel\|claude-" /Users/daryltaylor/Projects/ats-optimizer-web/functions/analyze.js | head -20
```

- [ ] **Step 3: Add repeat-user check and Discord call after captureAirtableLead**

Find this block in analyze.js (around line 250):
```javascript
    if (env.AIRTABLE_ATS_SECRET_KEY) {
      try { await captureAirtableLead(env.AIRTABLE_ATS_SECRET_KEY, { email, plan: userPlan, score: result.score, grade: result.grade, source: userPlan === 'free' ? 'free_scan' : 'paid_scan', jobMatch: isJobMatch }); }
      catch (e) { console.error('[analyze] Failed to capture Airtable lead:', e); }
    } else {
      console.error('[analyze] AIRTABLE_ATS_SECRET_KEY not set');
    }
```

Add immediately after that block (still inside `if (email) {`):

```javascript
    // Discord scan notification (best-effort)
    if (env.DISCORD_WEBHOOK_URL) {
      try {
        const repeat = await isRepeatUser(kv, email);
        await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, {
          email,
          plan: userPlan,
          score: result.score,
          grade: result.grade,
          jobMatch: isJobMatch,
          model: result.model || 'unknown',
          isRepeat: repeat,
        });
      } catch (e) {
        console.warn('[analyze] Discord notification failed:', e.message);
      }
    }
```

Note: `result.model` requires the model name to be included in the Claude API response object. If it isn't already, add it in Step 4.

- [ ] **Step 4: Ensure model name is available in the result**

Search for where `result` is built from the Claude API response:
```bash
grep -n "result\s*=" /Users/daryltaylor/Projects/ats-optimizer-web/functions/analyze.js | head -20
```

Find where the JSON is parsed from Claude's response (likely `JSON.parse(content)`). After parsing, add the model name if it isn't already included:

```javascript
// After: result = JSON.parse(content);
result.model = modelUsed; // use whatever variable holds the model name
```

If the model variable is named differently, adjust accordingly.

- [ ] **Step 5: Commit**

```bash
git add functions/analyze.js
git commit -m "feat: add Discord scan notification with repeat-user detection"
```

---

## Task 4: Add server-side PostHog events to stripe-webhook.js

**Files:**
- Modify: `functions/stripe-webhook.js`

These are fire-and-forget `fetch` calls to PostHog's `/capture` endpoint. No PII in event properties.

- [ ] **Step 1: Add the postHogCapture helper to stripe-webhook.js**

Add this function near the bottom of the file:

```javascript
async function postHogCapture(apiKey, host, event, properties = {}) {
  if (!apiKey || !host) return;
  try {
    await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: 'server',
        properties: { ...properties, $lib: 'cloudflare-function' },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn('[stripe-webhook] PostHog capture failed:', e.message);
  }
}
```

- [ ] **Step 2: Add payment_completed event in handleCheckoutCompleted**

Find the `console.log('[stripe-webhook] Token issued via webhook:', ...)` line in `handleCheckoutCompleted`. Add immediately after the `return json(...)` line that follows it — actually, add BEFORE the return:

```javascript
  // PostHog: server-side payment event (no PII)
  await postHogCapture(env.POSTHOG_PROJECT_TOKEN, env.POSTHOG_HOST, 'payment_completed', {
    plan: planKey,
    amount_cents: session.amount_total || 0,
  });
```

Note: `env` needs to be passed into `handleCheckoutCompleted`. Check the current function signature — it already receives `(session, kv, env)`, so `env` is available.

- [ ] **Step 3: Add subscription_cancelled event in handleSubscriptionDeleted**

Find the `return json({ received: true, cancelled: true, ... })` line in `handleSubscriptionDeleted`. Add immediately before it:

```javascript
  // PostHog: server-side cancellation event
  await postHogCapture(env.POSTHOG_PROJECT_TOKEN, env.POSTHOG_HOST, 'subscription_cancelled', {});
```

Note: Check if `env` is currently passed to `handleSubscriptionDeleted`. If not, update its call site in the `switch` block: `response = await handleSubscriptionDeleted(event.data.object, kv, env);` and add `env` to its signature.

- [ ] **Step 4: Commit**

```bash
git add functions/stripe-webhook.js
git commit -m "feat: add server-side PostHog events for payment and cancellation"
```

---

## Task 5: Wire secrets

This task is all manual steps — no code changes.

### GitHub Actions secrets (for PostHog token injection at deploy time)

- [ ] **Step 1: Add POSTHOG_PROJECT_TOKEN to GitHub Actions**

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `POSTHOG_PROJECT_TOKEN`
- Value: your PostHog project token

- [ ] **Step 2: Add POSTHOG_HOST to GitHub Actions**

- Name: `POSTHOG_HOST`
- Value: your PostHog host (e.g. `https://us.i.posthog.com`)

### Cloudflare Pages secrets (for runtime use by Functions)

- [ ] **Step 3: Add DISCORD_WEBHOOK_URL to Cloudflare Pages**

Go to Cloudflare dashboard → Pages → `ats-optimizer` → **Settings → Environment variables** → Add variable (set as **Secret**):

- Name: `DISCORD_WEBHOOK_URL`
- Value: your Discord webhook URL for channel 1488368518566252724

- [ ] **Step 4: Add POSTHOG_PROJECT_TOKEN to Cloudflare Pages**

Same location:

- Name: `POSTHOG_PROJECT_TOKEN`
- Value: your PostHog project token

- [ ] **Step 5: Add POSTHOG_HOST to Cloudflare Pages**

- Name: `POSTHOG_HOST`
- Value: `https://us.i.posthog.com` (or your region's host)

---

## Task 6: Commit wizard changes and deploy

- [ ] **Step 1: Stage all wizard-generated changes**

```bash
cd /Users/daryltaylor/Projects/ats-optimizer-web
git add public/js/posthog-init.js public/index.html public/tool/index.html public/cover-letter/index.html .github/workflows/deploy.yml
git status
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: add PostHog analytics — JS snippet, client-side events, CI token injection"
```

- [ ] **Step 3: Deploy**

```bash
./deploy.sh "feat: analytics + Discord scan notifications"
```

Or push to main to trigger GitHub Actions:

```bash
git push origin main
```

- [ ] **Step 4: Verify PostHog is receiving events**

After deploy, visit `https://atscore.ai/tool`, upload a resume and run a scan.

Go to PostHog → **Activity → Live Events** — you should see `scan_submitted`, `resume_analyzed`, etc. appear within seconds.

- [ ] **Step 5: Verify Discord notification fires**

After the scan completes, check the ATS Opti-Module Discord channel — you should see the rich embed with grade, score, plan, email, and repeat-user status.

- [ ] **Step 6: Verify Cloudflare Web Analytics**

Go to Cloudflare dashboard → `atscore.ai` → **Analytics & Logs → Web Analytics** — visit count should appear within a few minutes of traffic.

---

## Self-Review Notes

- Spec requires `posthog.identify()` — wizard already adds this on `resume_analyzed` using email. ✅
- Spec requires no PII in `capture()` — wizard events only use score/grade/plan/file_type. ✅
- Spec requires Discord webhook to be best-effort — implemented with try/catch + `console.warn`. ✅
- Spec requires repeat-user detection via KV SHA-256 hash — Task 3 implements this. ✅
- `handleSubscriptionDeleted` may need `env` added to its call — noted in Task 4 Step 3. Must verify at implementation time.
- `result.model` may or may not already be in the analyze.js response object — Task 3 Step 4 handles this conditionally. Must verify at implementation time.
