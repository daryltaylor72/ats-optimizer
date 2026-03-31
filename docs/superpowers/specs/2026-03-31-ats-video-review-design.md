# ATS Video Resume Review — Design Spec
_Date: 2026-03-31_

## Overview

Wire up actual video generation for the ATS Optimizer's "AI Video Resume Review" feature. Currently the feature generates a coaching script (text) but does not produce a video. This spec covers adding ElevenLabs TTS + Hedra lip-sync to produce a real 60–90s coaching video, displayed in-page via a polling architecture.

---

## Architecture

Three runtime components plus one-time setup:

### One-time setup
1. Generate a career coach portrait using Imagen 4 (professional female, photorealistic, neutral background).
2. Pre-upload the portrait to Hedra via their asset upload API → get a persistent portrait asset ID.
3. Store the asset ID as CF Pages secret `HEDRA_COACH_PORTRAIT_ID`.
4. Create an R2 bucket named `ats-videos` in the Cloudflare dashboard.
5. Add `VIDEO_BUCKET` R2 binding under Pages → ats-optimizer → Settings → Functions.

### Modified `/video-review` function
After generating the coaching script (existing Claude call), the function now also:
1. Calls ElevenLabs TTS with the script text, voice: **Serena** (`pMsXgVXv3BLzUgSXRplE`), model: `eleven_turbo_v2` (~5s).
2. Uploads the audio buffer to Hedra → gets audio asset ID (~3s).
3. Starts a Hedra generation job (`veo3-fast` model, portrait asset ID + audio asset ID) → gets `jobId` (~1s).
4. Writes `video:{jobId}` to KV with status `"processing"` (TTL: 24h).
5. Returns `{ script, keyStrengths, improvements, nextStep, jobId, scansRemaining }` immediately.

Total added latency: ~10–15s. Well within CF Worker 30s limit.

### New `/video-status` function
Stateless endpoint called by the frontend every 5 seconds.

```
GET /video-status?jobId={jobId}&token={token}
```

Logic:
1. Read `video:{jobId}` from KV.
2. If `status === "complete"` → return `{ status: "complete", videoUrl }`.
3. If `status === "failed"` → return `{ status: "failed" }`.
4. If `status === "processing"`:
   - Call Hedra status API for `hedraJobId`.
   - If Hedra says `"completed"`: download video buffer → upload to R2 → update KV to `"complete"` with R2 URL → return `{ status: "complete", videoUrl }`.
   - If Hedra says still running → return `{ status: "processing" }`.
   - If job is >8 minutes old → update KV to `"failed"` → return `{ status: "failed" }`.
5. If R2 upload fails → use Hedra's own CDN URL as `videoUrl` (expires in ~24h, sufficient for immediate viewing).

Token validation: verify the `token` in the query string owns the `video:{jobId}` record (check `token` field in KV). Reject mismatches with 403.

### Frontend changes (`public/tool/index.html`)
After `generateVideoReview()` receives the response:
1. Render script, strengths, and improvements immediately (existing behavior).
2. If `jobId` is present in the response, start polling:
   - Replace static "email" note with a progress bar + rotating status message.
   - Status messages (cycle every ~15s): "Generating audio…" → "Rendering coaching video…" → "Almost done…"
   - Poll `GET /video-status?jobId=X&token=Y` every 5 seconds.
3. On `status: "complete"`:
   - Remove progress bar.
   - Insert `<video controls autoplay muted>` with `src=videoUrl`.
4. On `status: "failed"` or timeout (>10 min client-side):
   - Show: "Video generation timed out — your coaching script is above."
5. If response has no `jobId` (ElevenLabs error):
   - Show script only, no video section.

---

## KV Schema

```
Key:   video:{jobId}
Value: {
  status:      "processing" | "complete" | "failed",
  hedraJobId:  "abc123",
  videoUrl:    null | "https://pub-xxx.r2.dev/ats-videos/abc123.mp4",
  createdAt:   "2026-03-31T22:00:00Z",
  token:       "user-token-string"
}
TTL: 86400 seconds (24 hours)
```

---

## New Secrets Required

| Secret | Description |
|--------|-------------|
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `HEDRA_API_KEY` | Hedra API key (same as ScopeCreepTV) |
| `HEDRA_COACH_PORTRAIT_ID` | Pre-uploaded Hedra portrait asset ID |

Existing: `TOKENS_KV`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `STRIPE_*` — unchanged.

New R2 binding:
| Binding | Bucket |
|---------|--------|
| `VIDEO_BUCKET` | `ats-videos` |

The `ats-videos` bucket must have **public access enabled** (R2 dashboard → bucket → Settings → Public access) so video URLs are directly playable in the browser. The CF Worker writes to the bucket via the binding; the frontend reads via the public CDN URL.

---

## Code Changes

| File | Change |
|------|--------|
| `functions/video-review.js` | Add ElevenLabs TTS + Hedra job kickoff after script generation |
| `functions/video-status.js` | New file — Hedra poll + R2 upload + return URL |
| `public/tool/index.html` | Polling loop + video player UI, replace static email note |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| ElevenLabs API error | Return script-only response (no `jobId`), no video section shown |
| Hedra job takes >8 min | KV → `"failed"`, frontend shows timeout message |
| R2 upload fails | Use Hedra CDN URL as fallback `videoUrl` |
| Frontend open >10 min | Client-side timeout, show error message |
| Invalid/mismatched token on `/video-status` | 403, no data returned |

---

## Cost Per Video

| Service | Cost |
|---------|------|
| ElevenLabs TTS (~1200 chars) | ~$0.36 |
| Hedra veo3-fast (8s clip) | ~$0.05 |
| R2 storage (10MB video, 1 day) | <$0.01 |
| **Total** | **~$0.42/video** |

---

## Out of Scope

- Email delivery of video link
- Multiple avatar characters or user-selectable voices
- Video caching across users (each video is unique per resume)
- Mozi captions (not needed for this use case)
