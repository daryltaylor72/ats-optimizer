/**
 * GET /verify-payment?session_id=cs_xxx&plan=starter
 * Verifies Stripe payment, issues a token stored in KV.
 * Returns: { token, plan, scans_remaining }
 */

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

const PLAN_SCANS = { single: 1, starter: 5, pro: 9999 };

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const planKey   = url.searchParams.get('plan');

  if (!sessionId || !planKey) return json({ error: 'Missing params' }, 400);

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

  // Verify the session with Stripe
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
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
  const kv = env.TOKENS_KV;
  if (kv) {
    const existing = await kv.get(`session:${sessionId}`);
    if (existing) {
      const token = JSON.parse(existing);
      return json({ token: token.token, plan: token.plan, scans_remaining: token.scans_remaining });
    }
  }

  const scans = PLAN_SCANS[planKey] || 1;
  const token = generateToken();
  const expiresAt = planKey === 'pro'
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()  // 30 days
    : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

  const customerEmail = session.customer_details?.email || session.customer_email || null;

  const tokenData = {
    token,
    plan: planKey,
    scans_remaining: scans,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    session_id: sessionId,
    email: customerEmail,
  };

  // Store token in KV (primary key), session→token mapping, and email→token for recovery
  if (kv) {
    const ttlSeconds = planKey === 'pro' ? 30 * 24 * 3600 : 365 * 24 * 3600;
    const writes = [
      kv.put(`token:${token}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds }),
      kv.put(`session:${sessionId}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds }),
    ];
    if (customerEmail) {
      writes.push(kv.put(`email:${customerEmail.toLowerCase()}`, token, { expirationTtl: ttlSeconds }));
    }
    await Promise.all(writes);
  }

  // Send receipt email
  let receiptError = null;
  if (customerEmail && env.RESEND_API_KEY) {
    try { await sendReceiptEmail(env.RESEND_API_KEY, customerEmail, planKey, scans, token); }
    catch (e) { receiptError = e.message; }
  }

  return json({ token, plan: planKey, scans_remaining: scans, _receipt_email: customerEmail || 'no email', _receipt_error: receiptError });
}

const PLAN_LABELS = {
  single:  { name: 'Single Scan',    desc: '1 AI-optimized resume rewrite',           price: '$5' },
  starter: { name: 'Starter Pack',   desc: '5 AI-optimized resume rewrites',          price: '$19' },
  pro:     { name: 'Pro — Unlimited', desc: 'Unlimited rewrites for 30 days',         price: '$39/mo' },
};

async function sendReceiptEmail(apiKey, to, planKey, scans, token) {
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
      <a href="https://ats.deeptierlabs.com/tool?token=${token}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Start Optimizing Your Resume →
      </a>
      <p style="color:#5a6080;font-size:12px;margin-top:12px;">Bookmark this link or save this email — it restores your scans on any device.</p>
    </div>

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;margin-bottom:32px;">
      <p style="color:#9299b0;font-size:13px;margin:0;line-height:1.6;">
        💡 <strong style="color:#e8eaf0;">Tip:</strong> For best results, paste the job description you're applying to into the tool — your resume will be rewritten to match that specific role.
      </p>
    </div>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">Questions? <a href="mailto:support@deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">support@deeptierlabs.com</a> · <a href="https://ats.deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">ats.deeptierlabs.com</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't receive this email, check your spam or promotions folder.</p>
    </div>
  </div>
</body>
</html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ATS Optimizer <results@deeptierlabs.com>',
      reply_to: ['support@deeptierlabs.com'],
      to: [to],
      subject: `Your ${plan.name} is ready — let's optimize your resume`,
      html,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
