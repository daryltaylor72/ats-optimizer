import { getLeadMagnetDueStage, sendLeadMagnetStageEmail } from './_lead-magnet-email.js';

const MAX_BATCH = 50;
const CLAIM_TTL_DAYS = 30;

export async function onRequestPost({ request, env }) {
  const kv = env.TOKENS_KV;
  const resendKey = env.RESEND_API_KEY;
  if (!kv || !resendKey) {
    return json({ ok: false, status: 'disabled' }, 503);
  }

  const origin = new URL(request.url).origin;
  const processed = [];
  let sent = 0;
  let examined = 0;
  let cursor;

  do {
    const page = await kv.list({ prefix: 'leadmagnet:claim:', cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const key of page.keys) {
      if (examined >= MAX_BATCH) break;
      examined += 1;

      const raw = await kv.get(key.name);
      if (!raw) continue;

      let claim;
      try {
        claim = JSON.parse(raw);
      } catch {
        continue;
      }

      const stage = getLeadMagnetDueStage(claim);
      if (!stage) continue;

      try {
        await sendLeadMagnetStageEmail(resendKey, {
          stage,
          email: claim.email,
          code: claim.code,
          expiresAt: claim.expires_at,
          origin,
        });
      } catch (error) {
        console.error('[lead-magnet-drip] Failed to send stage email', {
          email: claim.email,
          stage,
          error: error.message,
        });
        processed.push({ email: claim.email, stage, status: 'error' });
        continue;
      }

      const now = new Date().toISOString();
      if (stage === 'stage_2') claim.email_2_sent_at = now;
      if (stage === 'stage_3') claim.email_3_sent_at = now;
      if (stage === 'stage_4') claim.email_4_sent_at = now;
      if (stage === 'feedback') claim.feedback_requested_at = now;

      const ttl = remainingClaimTtl(claim);
      await kv.put(key.name, JSON.stringify(claim), { expirationTtl: ttl });
      sent += 1;
      processed.push({ email: claim.email, stage, status: 'sent' });
    }
  } while (cursor && examined < MAX_BATCH);

  return json({
    ok: true,
    examined,
    sent,
    processed,
    truncated: !!cursor,
  });
}

function remainingClaimTtl(claim) {
  const base = Date.parse(claim?.issued_at || '') + CLAIM_TTL_DAYS * 24 * 3600 * 1000;
  if (Number.isFinite(base)) {
    return Math.max(60, Math.ceil((base - Date.now()) / 1000));
  }
  return CLAIM_TTL_DAYS * 24 * 3600;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
