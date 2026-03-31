# ATS Video Resume Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up real video generation for the ATS Video Resume Review feature — ElevenLabs TTS (Serena voice) + Hedra lip-sync → stored in R2 → displayed in-page via 5s polling.

**Architecture:** `/video-review` generates the coaching script (existing), then calls ElevenLabs for audio, uploads audio to Hedra, and starts a lip-sync job — storing the Hedra job ID in KV. A new `/video-status` endpoint is polled every 5s by the frontend; when Hedra completes, the CF Worker downloads the video, uploads it to R2, and returns the public URL. The frontend swaps a rotating progress indicator for a `<video>` player.

**Tech Stack:** Cloudflare Pages Functions (ESM Workers), ElevenLabs TTS API v1, Hedra v1 API (`mercury.dev.dream-ai.com`), Cloudflare R2, Cloudflare KV (`TOKENS_KV`), Node.js 18+ for tests

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `functions/_video-helpers.js` | **Create** | Pure async helpers: ElevenLabs TTS call, Hedra asset upload, Hedra job start, Hedra status check |
| `functions/video-review.js` | **Modify** | After script generation: call TTS + Hedra kickoff, write jobId to KV, return jobId in response |
| `functions/video-status.js` | **Create** | GET endpoint — read KV, poll Hedra, download video, upload to R2, return URL |
| `public/tool/index.html` | **Modify** | Replace static email note with polling loop + animated progress + `<video>` player |
| `test/video-helpers.test.js` | **Create** | Unit tests for `_video-helpers.js` with mocked fetch |

---

## Task 0: One-Time Infrastructure Setup (Manual)

_Do this before writing any code. These steps configure external services._

- [ ] **Step 1: Get or create the career coach portrait**

  If you have a suitable portrait PNG (professional female, photorealistic, neutral background), use it. Otherwise generate one with Imagen 4:
  ```bash
  cd ~/Projects/worksona-videos
  python3 -c "
  import requests, os, base64
  from pathlib import Path
  key = os.environ.get('GOOGLE_API_KEY','')
  resp = requests.post(
    'https://generativelanguage.googleapis.com/v1beta/models/imagen-4:generateImages',
    headers={'Content-Type':'application/json','x-goog-api-key':key},
    json={'prompt':'Professional female career coach, photorealistic portrait, business attire, warm smile, neutral light gray background, 4K, studio lighting, looking directly at camera','numberOfImages':1,'aspectRatio':'1:1'}
  )
  img_b64 = resp.json()['generatedImages'][0]['image']['imageBytes']
  Path('ats_coach_portrait.png').write_bytes(base64.b64decode(img_b64))
  print('Saved ats_coach_portrait.png')
  "
  ```
  Expected: `ats_coach_portrait.png` in the worksona-videos directory.

- [ ] **Step 2: Upload portrait to Hedra, get asset ID**

  ```bash
  cd ~/Projects/worksona-videos
  python3 -c "
  import requests, os
  key = open('.env').read(); key = [l.split('=',1)[1].strip() for l in key.splitlines() if l.startswith('HEDRA_API_KEY=')][0]
  with open('ats_coach_portrait.png','rb') as f:
      resp = requests.post('https://mercury.dev.dream-ai.com/api/v1/assets',
          headers={'X-API-Key': key},
          files={'file': ('ats_coach_portrait.png', f, 'image/png')})
  print('Portrait asset ID:', resp.json()['id'])
  "
  ```
  Copy the printed asset ID — this becomes `HEDRA_COACH_PORTRAIT_ID`.

- [ ] **Step 3: Create R2 bucket in Cloudflare dashboard**

  1. Go to Cloudflare dashboard → R2 → Create bucket → name: `ats-videos`
  2. After creation: Settings → Public access → Enable → copy the public URL (format: `https://pub-{hash}.r2.dev`)
  3. The public URL base (without trailing slash) becomes `R2_VIDEOS_PUBLIC_URL`.

- [ ] **Step 4: Add R2 binding to CF Pages project**

  1. CF dashboard → Pages → `ats-optimizer` → Settings → Functions
  2. R2 bucket bindings → Add binding → Variable name: `VIDEO_BUCKET`, Bucket: `ats-videos`
  3. Save.

- [ ] **Step 5: Add CF Pages secrets**

  ```bash
  cd ~/Projects/ats-optimizer-web
  npx wrangler pages secret put ELEVENLABS_API_KEY --project-name=ats-optimizer
  # paste your ElevenLabs API key

  npx wrangler pages secret put HEDRA_API_KEY --project-name=ats-optimizer
  # paste your Hedra API key

  npx wrangler pages secret put HEDRA_COACH_PORTRAIT_ID --project-name=ats-optimizer
  # paste the asset ID from Step 2

  npx wrangler pages secret put R2_VIDEOS_PUBLIC_URL --project-name=ats-optimizer
  # paste the R2 public URL base from Step 3 (e.g. https://pub-abc123.r2.dev)
  ```

---

## Task 1: Create `functions/_video-helpers.js`

**Files:**
- Create: `functions/_video-helpers.js`

- [ ] **Step 1: Create the file**

  ```javascript
  /**
   * _video-helpers.js — ElevenLabs TTS + Hedra API helpers
   * Used by video-review.js and video-status.js
   */

  const HEDRA_BASE = 'https://mercury.dev.dream-ai.com/api';
  const HEDRA_VEO3_FAST = '9963e814-d1ee-4518-a844-7ed380ddbb20';
  const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
  const ELEVENLABS_VOICE_ID = 'pMsXgVXv3BLzUgSXRplE'; // Serena
  const ELEVENLABS_MODEL = 'eleven_turbo_v2';

  /**
   * Generate TTS audio using ElevenLabs.
   * @param {string} text  The script to speak aloud
   * @param {string} apiKey
   * @returns {Promise<ArrayBuffer>}  MP3 audio buffer
   */
  export async function callElevenLabs(text, apiKey) {
    const resp = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`ElevenLabs error ${resp.status}: ${err.slice(0, 200)}`);
    }
    return resp.arrayBuffer();
  }

  /**
   * Upload a binary asset (audio or image) to Hedra.
   * @param {ArrayBuffer} buffer
   * @param {string} contentType  e.g. 'audio/mpeg' or 'image/png'
   * @param {string} fileName     e.g. 'coaching.mp3'
   * @param {string} apiKey
   * @returns {Promise<string>}   Hedra asset ID
   */
  export async function hedraUploadAsset(buffer, contentType, fileName, apiKey) {
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: contentType }), fileName);
    const resp = await fetch(`${HEDRA_BASE}/v1/assets`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: formData,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Hedra upload error ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.id;
  }

  /**
   * Start a Hedra lip-sync generation job.
   * @param {string} portraitAssetId  Pre-uploaded portrait asset ID (from HEDRA_COACH_PORTRAIT_ID secret)
   * @param {string} audioAssetId     Freshly uploaded audio asset ID
   * @param {string} apiKey
   * @returns {Promise<string>}       Hedra job ID
   */
  export async function hedraStartJob(portraitAssetId, audioAssetId, apiKey) {
    const resp = await fetch(`${HEDRA_BASE}/v1/characters`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: HEDRA_VEO3_FAST,
        avatarImage: portraitAssetId,
        audioSource: audioAssetId,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Hedra start job error ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.jobId;
  }

  /**
   * Get the current status of a Hedra generation job.
   * @param {string} hedraJobId
   * @param {string} apiKey
   * @returns {Promise<{status: string, videoUrl: string|null}>}
   *   status: 'completed' | 'failed' | 'processing' (or any other Hedra status string)
   */
  export async function hedraGetStatus(hedraJobId, apiKey) {
    const resp = await fetch(`${HEDRA_BASE}/v1/characters/${hedraJobId}`, {
      headers: { 'X-API-Key': apiKey },
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Hedra status error ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    return { status: data.status, videoUrl: data.videoUrl || null };
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  cd ~/Projects/ats-optimizer-web
  git add functions/_video-helpers.js
  git commit -m "feat: add ElevenLabs + Hedra helper module"
  ```

---

## Task 2: Test `_video-helpers.js`

**Files:**
- Create: `test/video-helpers.test.js`

- [ ] **Step 1: Create the test file**

  ```javascript
  /**
   * video-helpers.test.js
   * Tests for _video-helpers.js with mocked fetch.
   *
   * Usage: node test/video-helpers.test.js
   */

  import { callElevenLabs, hedraUploadAsset, hedraStartJob, hedraGetStatus }
    from '../functions/_video-helpers.js';

  // ─── Test harness ──────────────────────────────────────────────────────────
  let passed = 0, failed = 0;

  function assert(condition, label) {
    if (condition) { console.log(`  ✅  ${label}`); passed++; }
    else { console.error(`  ❌  FAIL: ${label}`); failed++; }
  }

  async function test(label, fn) {
    console.log(`\n▶ ${label}`);
    try { await fn(); }
    catch (e) { console.error(`  ❌  THREW: ${e.message}`); failed++; }
  }

  // ─── Fetch mock utilities ──────────────────────────────────────────────────
  const originalFetch = globalThis.fetch;
  let mockQueue = [];

  function enqueueMock(response) {
    mockQueue.push(response);
  }

  function installMockFetch() {
    globalThis.fetch = async (url, opts) => {
      const mock = mockQueue.shift();
      if (!mock) throw new Error(`Unexpected fetch call to ${url}`);
      return {
        ok: mock.ok ?? true,
        status: mock.status ?? 200,
        text: async () => mock.text ?? '',
        json: async () => mock.json ?? {},
        arrayBuffer: async () => mock.arrayBuffer ?? new ArrayBuffer(8),
      };
    };
  }

  function uninstallMockFetch() {
    globalThis.fetch = originalFetch;
    mockQueue = [];
  }

  // ─── callElevenLabs tests ─────────────────────────────────────────────────
  await test('callElevenLabs — success returns ArrayBuffer', async () => {
    installMockFetch();
    const fakeAudio = new ArrayBuffer(1024);
    enqueueMock({ ok: true, arrayBuffer: fakeAudio });
    const result = await callElevenLabs('Hello world', 'fake-key');
    assert(result === fakeAudio, 'returns the ArrayBuffer from response');
    uninstallMockFetch();
  });

  await test('callElevenLabs — API error throws with status code', async () => {
    installMockFetch();
    enqueueMock({ ok: false, status: 401, text: 'Unauthorized' });
    let threw = false;
    try { await callElevenLabs('Hello', 'bad-key'); }
    catch (e) {
      threw = true;
      assert(e.message.includes('401'), `error includes status code (got: ${e.message})`);
    }
    assert(threw, 'throws on non-ok response');
    uninstallMockFetch();
  });

  // ─── hedraUploadAsset tests ───────────────────────────────────────────────
  await test('hedraUploadAsset — success returns asset ID', async () => {
    installMockFetch();
    enqueueMock({ ok: true, json: { id: 'asset-abc123' } });
    const id = await hedraUploadAsset(new ArrayBuffer(16), 'audio/mpeg', 'audio.mp3', 'fake-key');
    assert(id === 'asset-abc123', `returns asset ID (got: ${id})`);
    uninstallMockFetch();
  });

  await test('hedraUploadAsset — API error throws', async () => {
    installMockFetch();
    enqueueMock({ ok: false, status: 500, text: 'Internal Server Error' });
    let threw = false;
    try { await hedraUploadAsset(new ArrayBuffer(16), 'audio/mpeg', 'audio.mp3', 'key'); }
    catch (e) { threw = true; assert(e.message.includes('500'), 'error includes status'); }
    assert(threw, 'throws on error');
    uninstallMockFetch();
  });

  // ─── hedraStartJob tests ──────────────────────────────────────────────────
  await test('hedraStartJob — success returns jobId', async () => {
    installMockFetch();
    enqueueMock({ ok: true, json: { jobId: 'job-xyz789' } });
    const jobId = await hedraStartJob('portrait-id', 'audio-id', 'fake-key');
    assert(jobId === 'job-xyz789', `returns jobId (got: ${jobId})`);
    uninstallMockFetch();
  });

  await test('hedraStartJob — API error throws', async () => {
    installMockFetch();
    enqueueMock({ ok: false, status: 422, text: 'Invalid asset' });
    let threw = false;
    try { await hedraStartJob('p', 'a', 'k'); }
    catch (e) { threw = true; assert(e.message.includes('422'), 'error includes status'); }
    assert(threw, 'throws on error');
    uninstallMockFetch();
  });

  // ─── hedraGetStatus tests ─────────────────────────────────────────────────
  await test('hedraGetStatus — completed returns status and videoUrl', async () => {
    installMockFetch();
    enqueueMock({ ok: true, json: { status: 'completed', videoUrl: 'https://cdn.hedra.ai/video.mp4' } });
    const result = await hedraGetStatus('job-123', 'fake-key');
    assert(result.status === 'completed', `status is completed (got: ${result.status})`);
    assert(result.videoUrl === 'https://cdn.hedra.ai/video.mp4', 'videoUrl is returned');
    uninstallMockFetch();
  });

  await test('hedraGetStatus — processing returns null videoUrl', async () => {
    installMockFetch();
    enqueueMock({ ok: true, json: { status: 'processing' } });
    const result = await hedraGetStatus('job-123', 'fake-key');
    assert(result.status === 'processing', 'status is processing');
    assert(result.videoUrl === null, 'videoUrl is null when processing');
    uninstallMockFetch();
  });

  await test('hedraGetStatus — API error throws', async () => {
    installMockFetch();
    enqueueMock({ ok: false, status: 404, text: 'Not Found' });
    let threw = false;
    try { await hedraGetStatus('bad-id', 'key'); }
    catch (e) { threw = true; assert(e.message.includes('404'), 'error includes status'); }
    assert(threw, 'throws on error');
    uninstallMockFetch();
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  ```

- [ ] **Step 2: Run tests — verify all pass**

  ```bash
  cd ~/Projects/ats-optimizer-web
  node test/video-helpers.test.js
  ```
  Expected: all `✅`, exit 0.

- [ ] **Step 3: Commit**

  ```bash
  git add test/video-helpers.test.js
  git commit -m "test: add unit tests for video helper module"
  ```

---

## Task 3: Modify `functions/video-review.js`

**Files:**
- Modify: `functions/video-review.js`

- [ ] **Step 1: Add import at the top of `video-review.js`**

  After the existing `import mammoth` line, add:
  ```javascript
  import { callElevenLabs, hedraUploadAsset, hedraStartJob } from './_video-helpers.js';
  ```

- [ ] **Step 2: Replace the final `return json(...)` with the video kickoff block**

  Find this line near the end of `onRequestPost` (currently line 165):
  ```javascript
    return json({ ...result, scans_remaining: tokenData.scans_remaining });
  ```

  Replace it with:
  ```javascript
    // ── Video pipeline kickoff ────────────────────────────────────────────
    // Runs after script generation. If any step fails, we still return the
    // script — the user gets text coaching at minimum.
    let jobId = null;
    const elevenlabsKey = env.ELEVENLABS_API_KEY;
    const hedraKey      = env.HEDRA_API_KEY;
    const portraitId    = env.HEDRA_COACH_PORTRAIT_ID;

    if (elevenlabsKey && hedraKey && portraitId) {
      try {
        // 1. TTS — script text → MP3 buffer
        const audioBuffer = await callElevenLabs(result.script, elevenlabsKey);
        // 2. Upload audio to Hedra
        const audioAssetId = await hedraUploadAsset(audioBuffer, 'audio/mpeg', 'coaching.mp3', hedraKey);
        // 3. Start Hedra lip-sync job
        const hedraJobId = await hedraStartJob(portraitId, audioAssetId, hedraKey);
        // 4. Write job record to KV; frontend polls /video-status?jobId=X
        jobId = crypto.randomUUID();
        await kv.put(`video:${jobId}`, JSON.stringify({
          status: 'processing',
          hedraJobId,
          videoUrl: null,
          createdAt: new Date().toISOString(),
          token,
        }), { expirationTtl: 86400 });
      } catch (_e) {
        // Video pipeline failed — degrade gracefully, return script only
        jobId = null;
      }
    }

    return json({ ...result, scans_remaining: tokenData.scans_remaining, job_id: jobId });
  ```

  Note: the field is `job_id` (snake_case) to be consistent with the existing response field naming (`scans_remaining`, `key_strengths`, etc.).

- [ ] **Step 3: Verify the file still has the `kv` variable in scope**

  The `kv` variable is assigned at line 22 as `const kv = env.TOKENS_KV;` and the token block uses `finally { await releaseScanMutex(kv, token); }`. The new code uses `kv` inside `onRequestPost` after the mutex block — confirm it's in scope (it is, as `kv` is declared at function scope before the mutex).

- [ ] **Step 4: Commit**

  ```bash
  git add functions/video-review.js
  git commit -m "feat: add ElevenLabs TTS + Hedra job kickoff to video-review"
  ```

---

## Task 4: Create `functions/video-status.js`

**Files:**
- Create: `functions/video-status.js`

- [ ] **Step 1: Create the file**

  ```javascript
  /**
   * GET /video-status?jobId={jobId}&token={token}
   *
   * Polls the status of a Hedra video generation job.
   * When Hedra reports 'completed', downloads the video and uploads it to R2.
   *
   * Returns:
   *   { status: 'processing' }
   *   { status: 'complete', videoUrl: 'https://...' }
   *   { status: 'failed' }
   */

  import { hedraGetStatus } from './_video-helpers.js';

  const TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes — mark as failed if exceeded

  export async function onRequestGet(context) {
    const { request, env } = context;
    const url    = new URL(request.url);
    const jobId  = url.searchParams.get('jobId')  || '';
    const token  = url.searchParams.get('token')  || '';

    if (!jobId || !token) return json({ detail: 'Missing jobId or token' }, 400);

    const kv           = env.TOKENS_KV;
    const hedraKey     = env.HEDRA_API_KEY;
    const bucket       = env.VIDEO_BUCKET;
    const r2PublicUrl  = env.R2_VIDEOS_PUBLIC_URL;

    if (!kv || !hedraKey || !bucket || !r2PublicUrl) {
      return json({ detail: 'Service not configured' }, 500);
    }

    // Read job record
    const raw = await kv.get(`video:${jobId}`);
    if (!raw) return json({ detail: 'Job not found' }, 404);

    const record = JSON.parse(raw);

    // Ownership check — prevents job ID enumeration
    if (record.token !== token) return json({ detail: 'Forbidden' }, 403);

    // Already resolved
    if (record.status === 'complete') return json({ status: 'complete', videoUrl: record.videoUrl });
    if (record.status === 'failed')   return json({ status: 'failed' });

    // Timeout check
    const ageMs = Date.now() - new Date(record.createdAt).getTime();
    if (ageMs > TIMEOUT_MS) {
      await kv.put(`video:${jobId}`, JSON.stringify({ ...record, status: 'failed' }), { expirationTtl: 86400 });
      return json({ status: 'failed' });
    }

    // Poll Hedra
    let hedraResult;
    try {
      hedraResult = await hedraGetStatus(record.hedraJobId, hedraKey);
    } catch (_e) {
      // Transient Hedra error — don't fail the job, let client retry
      return json({ status: 'processing' });
    }

    if (hedraResult.status !== 'completed') {
      return json({ status: 'processing' });
    }

    // Hedra completed — download video, upload to R2
    let videoUrl = hedraResult.videoUrl; // fallback: Hedra CDN URL (~24h expiry)
    try {
      const videoResp = await fetch(hedraResult.videoUrl);
      if (videoResp.ok) {
        const videoBuffer = await videoResp.arrayBuffer();
        const r2Key = `${jobId}.mp4`;
        await bucket.put(r2Key, videoBuffer, {
          httpMetadata: { contentType: 'video/mp4' },
        });
        videoUrl = `${r2PublicUrl}/${r2Key}`;
      }
    } catch (_e) {
      // R2 upload failed — videoUrl stays as Hedra CDN URL
    }

    // Persist completed state
    await kv.put(
      `video:${jobId}`,
      JSON.stringify({ ...record, status: 'complete', videoUrl }),
      { expirationTtl: 86400 }
    );

    return json({ status: 'complete', videoUrl });
  }

  export async function onRequestOptions() {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add functions/video-status.js
  git commit -m "feat: add /video-status polling endpoint"
  ```

---

## Task 5: Modify Frontend — Polling UI + Video Player

**Files:**
- Modify: `public/tool/index.html`

There are three areas to change in this file:

### 5a — CSS: add styles for progress bar and video player

- [ ] **Step 1: Find the `.vr-email-note` CSS block (around line 614)**

  After the existing `.vr-script-box` and related styles, add:
  ```css
  .vr-progress {
    margin-top: 20px;
    text-align: center;
  }
  .vr-progress-bar-track {
    width: 100%;
    height: 6px;
    background: var(--border, #e5e7eb);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .vr-progress-bar-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #4f46e5, #7c3aed);
    border-radius: 3px;
    transition: width 0.5s ease;
    animation: vr-pulse 2s ease-in-out infinite;
  }
  @keyframes vr-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  .vr-progress-label {
    font-size: 13px;
    color: var(--text3, #6b7280);
  }
  .vr-video-player {
    margin-top: 20px;
    width: 100%;
    border-radius: 10px;
    overflow: hidden;
    background: #000;
  }
  .vr-video-player video {
    width: 100%;
    display: block;
    border-radius: 10px;
  }
  ```

### 5b — HTML: replace the static email note

- [ ] **Step 2: Find this HTML block (around line 854)**

  ```html
        <div class="vr-email-note">
          <span class="vr-note-icon">📧</span>
          <span>Your personalized video is being generated and will be emailed to you shortly. Check your inbox in the next few minutes.</span>
        </div>
  ```

  Replace it with:
  ```html
        <div id="vrVideoSection">
          <!-- Progress bar (shown while generating) -->
          <div class="vr-progress" id="vrProgress" style="display:none;">
            <div class="vr-progress-bar-track">
              <div class="vr-progress-bar-fill" id="vrProgressFill"></div>
            </div>
            <div class="vr-progress-label" id="vrProgressLabel">Generating your coaching video…</div>
          </div>
          <!-- Video player (shown when complete) -->
          <div class="vr-video-player" id="vrVideoPlayer" style="display:none;">
            <video id="vrVideo" controls playsinline>
              Your browser does not support video playback.
            </video>
          </div>
          <!-- Error fallback -->
          <div id="vrVideoError" style="display:none; margin-top:16px; font-size:13px; color:var(--text3,#6b7280);">
            Video generation timed out — your coaching script is above.
          </div>
        </div>
  ```

### 5c — JavaScript: add polling logic

- [ ] **Step 3: Find the `generateVideoReview` function (around line 1622)**

  Replace the entire function with:
  ```javascript
  // ── Video Resume Review ────────────────────────────────────────────────────
  let _vrPollInterval = null;
  let _vrPollStartTime = null;
  const VR_POLL_INTERVAL_MS = 5000;
  const VR_MAX_WAIT_MS = 10 * 60 * 1000; // 10 min client-side hard stop
  const VR_STATUS_MESSAGES = [
    'Generating audio from your coaching script…',
    'Uploading to rendering pipeline…',
    'Rendering your lip-sync video…',
    'Almost done — finalizing your video…',
  ];

  async function generateVideoReview() {
    if (!currentToken) { alert('No token found. Please reload the page.'); return; }

    const btn = document.getElementById('videoReviewBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';

    const fd = new FormData();
    fd.append('token', currentToken);
    fd.append('resume', fileInput.files[0]);
    if (jdInput && jdInput.value.trim()) fd.append('job_description', jdInput.value);

    let data;
    try {
      const res = await fetch('/video-review', { method: 'POST', body: fd });
      data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Video review failed');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Generate Video Review';
      alert(e.message || 'An error occurred. Please try again.');
      return;
    }

    // Render coaching script immediately
    document.getElementById('vrScript').textContent = data.script || '';
    const strengthsList = document.getElementById('vrStrengths');
    strengthsList.innerHTML = '';
    (data.key_strengths || []).forEach(s => {
      const li = document.createElement('li'); li.textContent = s; strengthsList.appendChild(li);
    });
    const improvList = document.getElementById('vrImprovements');
    improvList.innerHTML = '';
    (data.improvements || []).forEach(i => {
      const li = document.createElement('li'); li.textContent = i; improvList.appendChild(li);
    });
    document.getElementById('videoReviewResult').classList.add('active');

    btn.disabled = false;
    btn.textContent = 'Generate Video Review';

    // Start video polling if a job_id was returned
    if (data.job_id) {
      _startVideoPolling(data.job_id, currentToken);
    }
  }

  function _startVideoPolling(jobId, token) {
    const progress    = document.getElementById('vrProgress');
    const fill        = document.getElementById('vrProgressFill');
    const label       = document.getElementById('vrProgressLabel');
    const player      = document.getElementById('vrVideoPlayer');
    const videoEl     = document.getElementById('vrVideo');
    const errorEl     = document.getElementById('vrVideoError');

    progress.style.display = 'block';
    player.style.display   = 'none';
    errorEl.style.display  = 'none';

    _vrPollStartTime = Date.now();
    let messageIndex = 0;
    label.textContent = VR_STATUS_MESSAGES[0];
    fill.style.width  = '10%';

    _vrPollInterval = setInterval(async () => {
      const elapsed = Date.now() - _vrPollStartTime;

      // Rotate status message every 20s
      const newIndex = Math.min(Math.floor(elapsed / 20000), VR_STATUS_MESSAGES.length - 1);
      if (newIndex !== messageIndex) {
        messageIndex = newIndex;
        label.textContent = VR_STATUS_MESSAGES[messageIndex];
      }

      // Advance progress bar (max 90% until complete)
      const pct = Math.min(10 + (elapsed / VR_MAX_WAIT_MS) * 80, 90);
      fill.style.width = `${pct}%`;

      // Client-side timeout
      if (elapsed > VR_MAX_WAIT_MS) {
        clearInterval(_vrPollInterval);
        progress.style.display = 'none';
        errorEl.style.display  = 'block';
        return;
      }

      // Poll server
      let statusData;
      try {
        const res = await fetch(`/video-status?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}`);
        statusData = await res.json();
      } catch (_e) {
        return; // network error — retry next interval
      }

      if (statusData.status === 'complete' && statusData.videoUrl) {
        clearInterval(_vrPollInterval);
        fill.style.width = '100%';
        setTimeout(() => {
          progress.style.display = 'none';
          videoEl.src = statusData.videoUrl;
          player.style.display = 'block';
          videoEl.play().catch(() => {}); // autoplay may be blocked — silent fail
        }, 400);
      } else if (statusData.status === 'failed') {
        clearInterval(_vrPollInterval);
        progress.style.display = 'none';
        errorEl.style.display  = 'block';
      }
    }, VR_POLL_INTERVAL_MS);
  }
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add public/tool/index.html
  git commit -m "feat: add video polling UI and player to video review section"
  ```

---

## Task 6: Deploy and Smoke Test

- [ ] **Step 1: Run existing tests to confirm nothing broken**

  ```bash
  cd ~/Projects/ats-optimizer-web
  node test/webhook.test.js
  node test/video-helpers.test.js
  ```
  Expected: both exit 0 with all `✅`.

- [ ] **Step 2: Confirm all 4 CF secrets are set**

  ```bash
  npx wrangler pages secret list --project-name=ats-optimizer
  ```
  Expected output includes: `ELEVENLABS_API_KEY`, `HEDRA_API_KEY`, `HEDRA_COACH_PORTRAIT_ID`, `R2_VIDEOS_PUBLIC_URL`.

- [ ] **Step 3: Deploy**

  ```bash
  ./deploy.sh "feat: add video generation to video resume review"
  ```
  Watch: https://github.com/daryltaylor72/ats-optimizer/actions

- [ ] **Step 4: Smoke test on live site**

  1. Go to https://ats-optimizer.pages.dev
  2. Upload a real resume PDF with a valid token.
  3. Click "Generate Video Review".
  4. Verify: coaching script appears within ~20s.
  5. Verify: progress bar appears and cycles through status messages.
  6. Wait ~2-3 min: video player appears and plays the coaching video.
  7. Open DevTools → Network tab: confirm `/video-status` polling calls return `200` with `{"status":"processing"}` and eventually `{"status":"complete","videoUrl":"..."}`.

- [ ] **Step 5: Test failure path**

  Temporarily set `HEDRA_COACH_PORTRAIT_ID` to a garbage value in the dashboard, trigger a review, and verify:
  - Coaching script still appears (graceful degradation).
  - No video section shown (no progress bar).
  Restore the correct value after.

---

## Self-Review Checklist

- [x] Spec: one-time setup → Task 0 ✓
- [x] Spec: ElevenLabs TTS with Serena voice in `_video-helpers.js` ✓
- [x] Spec: Hedra job kickoff in `video-review.js` ✓
- [x] Spec: `/video-status` endpoint with KV read + Hedra poll + R2 upload ✓
- [x] Spec: 8-min timeout → KV `"failed"` ✓
- [x] Spec: token ownership check on `/video-status` ✓
- [x] Spec: R2 upload failure → fallback to Hedra CDN URL ✓
- [x] Spec: ElevenLabs failure → script-only response, no video section ✓
- [x] Spec: frontend polling loop + rotating messages + video player ✓
- [x] Spec: client-side 10-min timeout → error message ✓
- [x] Spec: 4 new secrets documented in Task 0 ✓
- [x] R2 public access note → included in Task 0 Step 3 ✓
- [x] `job_id` field name used consistently across `video-review.js` return, frontend `data.job_id`, and `/video-status` query param ✓
- [x] CORS headers on `video-status.js` match existing pattern ✓
