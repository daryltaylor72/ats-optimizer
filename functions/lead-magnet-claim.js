import { sendLeadMagnetStageEmail } from './_lead-magnet-email.js';

const DEFAULT_CAP = 50;
const CLAIM_TTL_DAYS = 30;
const CODE_EXPIRY_DAYS = 7;

export async function onRequestPost({ request, env }) {
  const kv = env.TOKENS_KV;
  const resendKey = env.RESEND_API_KEY;
  if (!kv || !resendKey) return json({ ok: false, status: 'disabled' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, status: 'invalid_request' }, 400); }

  const email = (body.email || '').trim().toLowerCase();
  const variant = body.variant === 'B' ? 'B' : 'A';
  const activelyApplying = typeof body.activelyApplying === 'string' ? body.activelyApplying.trim().slice(0, 40) : '';
  const score = Number.isFinite(Number(body.score)) ? Number(body.score) : null;
  const hasJobDescription = !!body.hasJobDescription;
  const source = typeof body.source === 'string' ? body.source.trim().slice(0, 80) : 'tool_results';

  if (!isValidEmail(email)) {
    return json({ ok: false, status: 'invalid_email' }, 400);
  }

  const state = await readState(kv);
  if (!state.enabled) {
    return json({ ok: false, status: 'disabled' }, 403);
  }

  const claimKey = `leadmagnet:claim:${email}`;
  const existingRaw = await kv.get(claimKey);
  if (existingRaw) {
    let existing = null;
    try { existing = JSON.parse(existingRaw); } catch {}
    if (existing?.status) {
      return json({
        ok: true,
        status: 'already_claimed',
        expires_at: existing.expires_at || null,
      });
    }
  }

  if ((state.issued_count || 0) >= (state.cap || DEFAULT_CAP)) {
    return json({ ok: false, status: 'cap_reached' }, 409);
  }

  const code = await generateUniqueCode(kv);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const claim = {
    email,
    variant,
    status: 'issued',
    code,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
    redeemed_at: null,
    actively_applying: activelyApplying || null,
    score,
    has_job_description: hasJobDescription,
    source,
    email_1_sent_at: null,
    email_2_sent_at: null,
    email_3_sent_at: null,
    email_4_sent_at: null,
    feedback_requested_at: null,
  };

  const claimTtl = CLAIM_TTL_DAYS * 24 * 3600;
  const writes = [
    kv.put(claimKey, JSON.stringify(claim), { expirationTtl: claimTtl }),
    kv.put(`leadmagnet:code:${code}`, email, { expirationTtl: claimTtl }),
    kv.put('leadmagnet:state', JSON.stringify({
      ...state,
      issued_count: (state.issued_count || 0) + 1,
      updated_at: now.toISOString(),
    })),
  ];
  await Promise.all(writes);

  try {
    const origin = new URL(request.url).origin;
    await sendLeadMagnetStageEmail(resendKey, {
      stage: 'stage_1',
      email,
      code,
      expiresAt,
      origin,
    });
    claim.email_1_sent_at = new Date().toISOString();
    await kv.put(claimKey, JSON.stringify(claim), { expirationTtl: claimTtl });
  } catch (err) {
    console.error('[lead-magnet-claim] Failed to send unlock email:', err);
  }

  return json({ ok: true, status: 'issued', expires_at: expiresAt });
}

async function readState(kv) {
  const raw = await kv.get('leadmagnet:state');
  if (!raw) {
    return {
      enabled: true,
      cap: DEFAULT_CAP,
      issued_count: 0,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      cap: Number.isFinite(Number(parsed.cap)) ? Number(parsed.cap) : DEFAULT_CAP,
      issued_count: Number.isFinite(Number(parsed.issued_count)) ? Number(parsed.issued_count) : 0,
    };
  } catch {
    return {
      enabled: true,
      cap: DEFAULT_CAP,
      issued_count: 0,
    };
  }
}

async function generateUniqueCode(kv) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `ATS-${randomChunk(4)}-${randomChunk(4)}`;
    const existing = await kv.get(`leadmagnet:code:${code}`);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique unlock code');
}

function randomChunk(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
