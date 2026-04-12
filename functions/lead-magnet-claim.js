import { generateToken } from './_shared.js';

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
    await sendLeadMagnetEmail(resendKey, email, code, expiresAt, origin);
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

async function sendLeadMagnetEmail(apiKey, to, code, expiresAt, origin) {
  const expiresText = new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const toolUrl = `${origin}/tool/`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <table role="presentation" style="margin-bottom:32px;border-collapse:collapse;">
      <tr>
        <td style="padding-right:8px;vertical-align:middle;">
          <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;line-height:32px;text-align:center;font-size:16px;color:#fff;">A</div>
        </td>
        <td style="vertical-align:middle;">
          <span style="color:#e8eaf0;font-size:16px;font-weight:600;">ATScore</span>
        </td>
      </tr>
    </table>

    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 8px;">Your free premium unlock is ready</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 24px;">Use this one-time code on the results page to unlock one full premium report, including the rewrite guidance behind your score.</p>

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:24px;text-align:center;">
      <p style="color:#9299b0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px;">Your Unlock Code</p>
      <div style="color:#e8eaf0;font-size:28px;font-weight:700;letter-spacing:2px;">${code}</div>
      <p style="color:#5a6080;font-size:12px;margin:12px 0 0;">Expires ${expiresText}</p>
    </div>

    <div style="text-align:center;margin-bottom:32px;">
      <a href="${toolUrl}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Use My Free Unlock</a>
    </div>

    <p style="color:#9299b0;font-size:13px;line-height:1.7;margin:0 0 28px;">Paste the code into the “Have a free unlock code?” field on the results screen. One code per email. If you have questions, just reply to this email.</p>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">ATScore · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a> · <a href="mailto:support@atscore.ai" style="color:#6c63ff;text-decoration:none;">support@atscore.ai</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't request this, you can safely ignore it.</p>
    </div>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'ATScore <results@atscore.ai>',
      reply_to: ['support@atscore.ai'],
      to: [to],
      subject: 'Your free ATScore premium unlock is ready',
      html,
    }),
  });

  if (!res.ok) throw new Error(await res.text());
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
