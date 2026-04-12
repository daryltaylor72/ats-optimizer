import { generateToken } from './_shared.js';

/**
 * POST /auth-request
 * Body: { email }
 * Sends a passwordless sign-in link.
 */
export async function onRequestPost({ request, env }) {
  const generic = { ok: true };

  let body;
  try { body = await request.json(); } catch { return json(generic); }

  const email = (body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json(generic);

  const kv = env.TOKENS_KV;
  const resendKey = env.RESEND_API_KEY;
  if (!kv || !resendKey) return json(generic);

  const loginToken = generateToken();
  const origin = new URL(request.url).origin;
  const loginLink = `${origin}/auth-verify?token=${encodeURIComponent(loginToken)}`;

  await kv.put(`login:${loginToken}`, JSON.stringify({
    email,
    created_at: new Date().toISOString(),
  }), { expirationTtl: 15 * 60 });

  try {
    await sendLoginEmail(resendKey, email, loginLink);
  } catch (err) {
    console.error('[auth-request] Failed to send sign-in email:', err);
  }

  return json(generic);
}

async function sendLoginEmail(apiKey, to, link) {
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

    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 8px;">Sign in to your ATScore account</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 32px;">No password needed. Use the button below to access any scans, credits, or results tied to this email.</p>

    <div style="text-align:center;margin-bottom:32px;">
      <a href="${link}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Sign In →
      </a>
      <p style="color:#5a6080;font-size:12px;margin-top:12px;">This link expires in 15 minutes.</p>
    </div>

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
      subject: 'Sign in to ATScore',
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
      'Access-Control-Allow-Origin': '*',
    },
  });
}
