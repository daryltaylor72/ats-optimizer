/**
 * GET /verify-payment?session_id=cs_xxx
 * Verifies Stripe payment and issues a token stored in KV.
 * Returns: { ok, plan, scans_remaining }
 */

import { buildAccessGrantUrl, createAccessGrant } from './_access-links.js';
import { PLAN_SCANS, PLAN_LABELS, issueToken } from './_shared.js';
import { createTokenSessionCookie, getSessionSecret } from './_auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const ignoredPlan = url.searchParams.get('plan');

  if (!sessionId) return json({ error: 'Missing session_id' }, 400);
  if (ignoredPlan) {
    console.warn('[verify-payment] Ignoring client-supplied plan parameter', { sessionId, ignoredPlan });
  }

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);
  const kv = env.TOKENS_KV;
  if (!kv) return json({ error: 'Token storage not configured' }, 500);

  // Verify the session with Stripe
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` },
  });
  const session = await res.json();

  if (!res.ok || session.payment_status !== 'paid') {
    // Subscriptions use 'no_payment_required' before first invoice — check status
    const isSubscriptionActive =
      session.mode === 'subscription' && session.status === 'complete';
    if (!isSubscriptionActive) {
      return json({ error: 'Payment not confirmed' }, 402);
    }
  }

  // Check if we already issued a token for this session (prevent double-issue)
  const existing = await kv.get(`session:${sessionId}`);
  if (existing) {
    const tokenData = JSON.parse(existing);
    return json(
      { ok: true, plan: tokenData.plan, scans_remaining: tokenData.scans_remaining },
      200,
      await sessionHeaders(env, tokenData.token)
    );
  }

  const planKey = await derivePlanFromSession(session, stripeKey);
  if (!planKey) {
    console.error('[verify-payment] Unable to derive plan from Stripe session', {
      sessionId,
      metadataPlan: session.metadata?.plan || null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      mode: session.mode ?? null,
    });
    return json({ error: 'Unable to verify purchased plan' }, 400);
  }

  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const tokenData = await issueToken(kv, planKey, sessionId, customerEmail);

  // Send receipt email
  if (customerEmail && env.RESEND_API_KEY && tokenData) {
    try {
      const grant = await createAccessGrant(kv, tokenData.token, { redirectPath: '/tool/' });
      await sendReceiptEmail(env.RESEND_API_KEY, customerEmail, planKey, tokenData.scans_remaining, buildAccessGrantUrl(env, grant));
    } catch (e) {
      console.error('[verify-payment] Receipt email failed:', e);
    }
  }

  return json(
    { ok: true, plan: planKey, scans_remaining: tokenData.scans_remaining },
    200,
    await sessionHeaders(env, tokenData.token)
  );
}

async function sessionHeaders(env, token) {
  const secret = getSessionSecret(env);
  if (!secret || !token) return {};
  return {
    'Set-Cookie': await createTokenSessionCookie(token, secret),
  };
}

async function derivePlanFromSession(session, stripeKey) {
  const metadataPlan = session.metadata?.plan;
  if (metadataPlan && PLAN_SCANS[metadataPlan] !== undefined) {
    return metadataPlan;
  }

  const lineItems = session.line_items?.data;
  const inferredFromItems = inferPlanFromLineItems(lineItems);
  if (inferredFromItems) {
    return inferredFromItems;
  }

  return inferPlanFromAmount(session);
}

function inferPlanFromLineItems(lineItems = []) {
  for (const item of lineItems) {
    const metadataPlan = item.price?.metadata?.plan || item.price?.product?.metadata?.plan;
    if (metadataPlan && PLAN_SCANS[metadataPlan] !== undefined) {
      return metadataPlan;
    }

    const lookupKey = item.price?.lookup_key;
    if (lookupKey && PLAN_SCANS[lookupKey] !== undefined) {
      return lookupKey;
    }
  }

  return null;
}

function inferPlanFromAmount(session) {
  const amountTotal = session.amount_total;
  if (typeof amountTotal !== 'number') {
    return null;
  }

  const amountMap = {
    usd: {
      payment: {
        500: 'single',
        1900: 'starter',
      },
      subscription: {
        3900: 'pro',
      },
    },
  };

  const currency = (session.currency || 'usd').toLowerCase();
  const mode = session.mode === 'subscription' ? 'subscription' : 'payment';
  return amountMap[currency]?.[mode]?.[amountTotal] || null;
}

async function sendReceiptEmail(apiKey, to, planKey, scans, accessUrl) {
  const plan = PLAN_LABELS[planKey] || { name: planKey, desc: '', price: '' };
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
      <a href="${accessUrl}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Start Optimizing Your Resume →
      </a>
      <p style="color:#5a6080;font-size:12px;margin-top:12px;">Save this email if you need to restore access again later.</p>
    </div>

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;margin-bottom:32px;">
      <p style="color:#9299b0;font-size:13px;margin:0;line-height:1.6;">
        💡 <strong style="color:#e8eaf0;">Tip:</strong> For best results, paste the job description you're applying to into the tool — your resume will be rewritten to match that specific role.
      </p>
    </div>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">Questions? <a href="mailto:support@atscore.ai" style="color:#6c63ff;text-decoration:none;">support@atscore.ai</a> · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't receive this email, check your spam or promotions folder.</p>
    </div>
  </div>
</body>
</html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ATScore <results@atscore.ai>',
      reply_to: ['support@atscore.ai'],
      to: [to],
      subject: `Your ${plan.name} is ready — let's optimize your resume`,
      html,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extraHeaders },
  });
}
