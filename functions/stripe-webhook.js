/**
 * POST /stripe-webhook
 *
 * Stripe webhook handler — server-to-server authoritative payment confirmation.
 * This is the fallback (and preferred) path for token issuance; it fires regardless
 * of whether the browser redirect to /success completes.
 *
 * Handled events:
 *  - checkout.session.completed   → issue token for one-time + subscription purchases
 *  - invoice.paid                 → extend Pro token TTL on subscription renewal
 *  - customer.subscription.deleted → invalidate Pro token on cancellation
 *
 * Security:
 *  - All events are verified via HMAC-SHA256 (Stripe-Signature header)
 *  - Raw body is read BEFORE JSON.parse (required for signature correctness)
 *  - Idempotent: duplicate events are safely ignored via session: KV key
 *  - STRIPE_WEBHOOK_SECRET must be set as a Cloudflare Pages secret
 */

import { verifyStripeSignature, issueToken, PLAN_SCANS, PLAN_LABELS } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── 1. Read raw body as text BEFORE any parsing ───────────────────────────
  // CRITICAL: Stripe signature is computed against the raw bytes.
  // Parsing to JSON first corrupts whitespace and breaks verification.
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: 'Could not read request body' }, 400);
  }

  // ── 2. Verify Stripe signature ────────────────────────────────────────────
  const sigHeader = request.headers.get('stripe-signature');
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    // If secret is not configured, refuse all webhook traffic
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return json({ error: 'Webhook secret not configured' }, 500);
  }

  const verification = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!verification.ok) {
    console.warn('[stripe-webhook] Signature verification failed:', verification.reason);
    return json({ error: 'Invalid signature', reason: verification.reason }, 400);
  }

  // ── 3. Parse the verified event ───────────────────────────────────────────
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const kv = env.TOKENS_KV;
  if (!kv) {
    console.error('[stripe-webhook] TOKENS_KV not bound');
    return json({ error: 'KV not configured' }, 500);
  }

  // ── 4. Route to event handlers ────────────────────────────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed':
        return await handleCheckoutCompleted(event.data.object, kv, env);

      case 'invoice.paid':
        return await handleInvoicePaid(event.data.object, kv, env);

      case 'customer.subscription.deleted':
        return await handleSubscriptionDeleted(event.data.object, kv);

      default:
        // Acknowledge unhandled events — Stripe expects a 2xx or it will retry
        return json({ received: true, handled: false, type: event.type }, 200);
    }
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err);
    // Return 500 so Stripe retries — but only for unexpected errors, not logic rejections
    return json({ error: 'Internal handler error', message: err.message }, 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Event Handlers
// ────────────────────────────────────────────────────────────────────────────

/**
 * checkout.session.completed
 * Fires when a Stripe Checkout session is paid (one-time or first subscription payment).
 * Issues a token if one hasn't already been issued for this session.
 */
async function handleCheckoutCompleted(session, kv, env) {
  const sessionId = session.id;
  const planKey   = session.metadata?.plan;

  if (!planKey || !PLAN_SCANS[planKey]) {
    console.warn('[stripe-webhook] checkout.session.completed: unknown plan in metadata:', planKey);
    return json({ received: true, warning: `unknown_plan:${planKey}` }, 200);
  }

  // Confirm payment is actually complete
  const isPaid = session.payment_status === 'paid' ||
    (session.mode === 'subscription' && session.status === 'complete');
  if (!isPaid) {
    return json({ received: true, warning: 'payment_not_confirmed', status: session.payment_status }, 200);
  }

  // Idempotency check — verify-payment.js may have already issued a token via browser redirect
  const existing = await kv.get(`session:${sessionId}`);
  if (existing) {
    const existingData = JSON.parse(existing);
    console.log('[stripe-webhook] Token already issued for session:', sessionId);
    return json({ received: true, idempotent: true, token_issued: existingData.token }, 200);
  }

  // Issue the token
  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const tokenData = await issueToken(kv, planKey, sessionId, customerEmail);

  // Send receipt email (best-effort — don't fail the webhook if email fails)
  if (customerEmail && env.RESEND_API_KEY) {
    try {
      await sendReceiptEmail(env.RESEND_API_KEY, customerEmail, planKey, tokenData.scans_remaining, tokenData.token);
    } catch (e) {
      console.warn('[stripe-webhook] Receipt email failed:', e.message);
    }
  }

  console.log('[stripe-webhook] Token issued via webhook:', tokenData.token, 'plan:', planKey);
  return json({ received: true, token_issued: tokenData.token, plan: planKey }, 200);
}

/**
 * invoice.paid
 * Fires on every successful subscription invoice, including renewals.
 * Extends the Pro token expiration by 30 days from today.
 */
async function handleInvoicePaid(invoice, kv, env) {
  // Only process subscription invoices (not one-time)
  if (invoice.billing_reason !== 'subscription_cycle' &&
      invoice.billing_reason !== 'subscription_create') {
    return json({ received: true, handled: false, reason: `billing_reason:${invoice.billing_reason}` }, 200);
  }

  const subscriptionId = invoice.subscription;
  const customerEmail  = invoice.customer_email || null;

  if (!subscriptionId) {
    return json({ received: true, warning: 'no_subscription_id' }, 200);
  }

  // Find the token associated with this subscription via email lookup
  // (Pro tokens are indexed by email in KV)
  let tokenRaw = null;
  let tokenKey = null;

  if (customerEmail) {
    const tokenRef = await kv.get(`email:${customerEmail.toLowerCase()}`);
    if (tokenRef) {
      tokenRaw = await kv.get(`token:${tokenRef}`);
      tokenKey = tokenRef;
    }
  }

  if (!tokenRaw) {
    console.warn('[stripe-webhook] invoice.paid: no token found for subscription:', subscriptionId, 'email:', customerEmail);
    // Can't extend — but don't fail the webhook. Stripe will not retry 200s.
    return json({ received: true, warning: 'token_not_found', subscription: subscriptionId }, 200);
  }

  const tokenData = JSON.parse(tokenRaw);

  // Extend expiration by 30 days from now
  const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const newTtlSecs   = 30 * 24 * 3600;

  tokenData.expires_at       = newExpiresAt;
  tokenData.scans_remaining  = PLAN_SCANS['pro']; // reset to 9999 on renewal
  tokenData.last_renewed_at  = new Date().toISOString();
  tokenData.subscription_id  = subscriptionId;

  await kv.put(`token:${tokenKey}`, JSON.stringify(tokenData), { expirationTtl: newTtlSecs });
  if (customerEmail) {
    await kv.put(`email:${customerEmail.toLowerCase()}`, tokenKey, { expirationTtl: newTtlSecs });
  }

  console.log('[stripe-webhook] Pro token renewed:', tokenKey, 'expires:', newExpiresAt);
  return json({ received: true, renewed: true, token: tokenKey, expires_at: newExpiresAt }, 200);
}

/**
 * customer.subscription.deleted
 * Fires when a subscription is cancelled (by user, failed payment, or admin).
 * Marks the token as cancelled and reduces scans to 0 so further rewrites are blocked.
 */
async function handleSubscriptionDeleted(subscription, kv) {
  const customerEmail = subscription.customer_email ||
    subscription.metadata?.customer_email || null;

  if (!customerEmail) {
    console.warn('[stripe-webhook] subscription.deleted: no customer email, cannot find token');
    return json({ received: true, warning: 'no_email_to_lookup' }, 200);
  }

  const tokenRef = await kv.get(`email:${customerEmail.toLowerCase()}`);
  if (!tokenRef) {
    return json({ received: true, warning: 'token_not_found_for_email' }, 200);
  }

  const tokenRaw = await kv.get(`token:${tokenRef}`);
  if (!tokenRaw) {
    return json({ received: true, warning: 'token_key_found_but_data_missing' }, 200);
  }

  const tokenData = JSON.parse(tokenRaw);

  // Invalidate: set scans to 0 and mark cancelled
  tokenData.scans_remaining = 0;
  tokenData.cancelled_at    = new Date().toISOString();
  tokenData.cancel_reason   = `subscription_deleted:${subscription.id}`;

  // Keep a short TTL so the record doesn't linger indefinitely (7 days for audit trail)
  const auditTtl = 7 * 24 * 3600;
  await kv.put(`token:${tokenRef}`, JSON.stringify(tokenData), { expirationTtl: auditTtl });

  console.log('[stripe-webhook] Pro token cancelled:', tokenRef, 'subscription:', subscription.id);
  return json({ received: true, cancelled: true, token: tokenRef }, 200);
}

// ────────────────────────────────────────────────────────────────────────────
// Email
// ────────────────────────────────────────────────────────────────────────────

async function sendReceiptEmail(apiKey, to, planKey, scans, token) {
  const plan      = PLAN_LABELS[planKey] || { name: planKey, desc: '', price: '' };
  const scansText = scans >= 9000 ? 'Unlimited (30 days)' : `${scans} scan${scans !== 1 ? 's' : ''}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:32px;">
      <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;line-height:32px;text-align:center;font-size:16px;">📄</div>
      <span style="color:#e8eaf0;font-size:16px;font-weight:600;">ATS Resume Optimizer</span>
    </div>
    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 8px;">You're all set! ✅</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 32px;">Your payment was confirmed and your scans are ready to use.</p>
    <div style="background:#111318;border:1px solid rgba(108,99,255,0.3);border-radius:12px;padding:24px;margin-bottom:32px;">
      <p style="color:#9299b0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 16px;">Your Plan</p>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <p style="color:#e8eaf0;font-size:16px;font-weight:600;margin:0 0 4px;">${plan.name}</p>
          <p style="color:#9299b0;font-size:13px;margin:0;">${plan.desc}</p>
        </div>
        <div style="text-align:right;">
          <p style="color:#6c63ff;font-size:20px;font-weight:700;margin:0;">${plan.price}</p>
          <p style="color:#9299b0;font-size:12px;margin:4px 0 0;">${scansText}</p>
        </div>
      </div>
    </div>
    <div style="text-align:center;margin-bottom:32px;">
      <a href="https://ats.deeptierlabs.com/tool?token=${token}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Start Optimizing Your Resume →
      </a>
      <p style="color:#5a6080;font-size:12px;margin-top:12px;">Bookmark this link — it restores your scans on any device.</p>
    </div>
    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0;">Questions? <a href="mailto:support@deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">support@deeptierlabs.com</a></p>
    </div>
  </div>
</body>
</html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:     'ATS Optimizer <results@deeptierlabs.com>',
      reply_to: ['support@deeptierlabs.com'],
      to:       [to],
      subject:  `Your ${plan.name} is ready — let's optimize your resume`,
      html,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':           'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
