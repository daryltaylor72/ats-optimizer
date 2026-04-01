/**
 * POST /create-checkout
 * Body: { plan: 'single' | 'starter' | 'pro' }
 * Returns: { url: '<stripe checkout url>' }
 */

const PLANS = {
  single:  { name: 'Single Scan',         amount: 1200, currency: 'usd', mode: 'payment',      scans: 1,    desc: '1 AI-optimized ATS resume rewrite'               },
  starter: { name: 'Starter Pack',        amount: 4900, currency: 'usd', mode: 'payment',      scans: 5,    desc: '5 AI-optimized resume rewrites ($9.80 each)'     },
  pro:     { name: 'Pro (30 days)',        amount: 4900, currency: 'usd', mode: 'subscription', scans: 9999, desc: 'Unlimited ATS resume analyses for 30 days'        },
  video:   { name: 'AI Video Coaching',   amount: 1900, currency: 'usd', mode: 'payment',      scans: 0,    desc: 'Personalized AI career coaching video review'     },
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const plan = PLANS[body.plan];
  if (!plan) return json({ error: 'Invalid plan' }, 400);

  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}&plan=${body.plan}`;
  const cancelUrl  = `${origin}/#pricing`;

  // Build Stripe Checkout Session params
  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    'line_items[0][price_data][currency]': plan.currency,
    'line_items[0][price_data][product_data][name]': `ResumeATS — ${plan.name}`,
    'line_items[0][price_data][product_data][description]': plan.desc,
    'line_items[0][price_data][unit_amount]': plan.amount,
    'line_items[0][quantity]': '1',
    'mode': plan.mode,
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    'metadata[plan]': body.plan,
    'metadata[scans]': plan.scans,
  });

  if (plan.mode === 'subscription') {
    params.set('line_items[0][price_data][recurring][interval]', 'month');
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await res.json();
  if (!res.ok) return json({ error: session.error?.message || 'Stripe error' }, 500);

  return json({ url: session.url });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
