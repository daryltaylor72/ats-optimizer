/**
 * _video-helpers.js — ElevenLabs TTS + Hedra API helpers
 * Underscore prefix prevents this file from being treated as a route by Cloudflare Pages.
 *
 * Exports:
 *  - callElevenLabs()       : Generate TTS audio using ElevenLabs
 *  - hedraUploadAsset()     : Upload binary asset (audio or image) to Hedra (two-step)
 *  - hedraStartJob()        : Start a Hedra lip-sync generation job
 *  - hedraGetStatus()       : Get current status of a Hedra generation job
 *
 * Used by:
 *  - video-review.js       : Kick off TTS + Hedra job after script generation
 *  - video-status.js       : Poll Hedra status and retrieve final video URL
 */

const HEDRA_BASE = 'https://api.hedra.com/web-app/public';
const HEDRA_CHARACTER_3 = 'd1dd37a3-e39a-4854-a298-6510289f9cf2'; // Auto-duration lip-sync, requires audio
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const ELEVENLABS_VOICE_ID = 'pMsXgVXv3BLzUgSXRplE'; // Serena
const ELEVENLABS_MODEL = 'eleven_turbo_v2';

/**
 * Generate TTS audio using ElevenLabs.
 * @param {string} text  The script to speak aloud
 * @param {string} apiKey
 * @returns {Promise<ArrayBuffer>}  MP3 audio buffer
 * @throws {Error}  ElevenLabs error with status and response preview
 */
export async function callElevenLabs(text, apiKey) {
  const url = `${ELEVENLABS_BASE}/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  const body = {
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.8,
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`ElevenLabs request failed: ${e.message}`);
  }

  if (!response.ok) {
    let errPreview = '';
    try {
      const errText = await response.text();
      errPreview = errText.substring(0, 200);
    } catch {
      errPreview = '(unable to read error body)';
    }
    throw new Error(`ElevenLabs error ${response.status}: ${errPreview}`);
  }

  return response.arrayBuffer();
}

/**
 * Upload a binary asset (audio or image) to Hedra (two-step: create record then upload file).
 * @param {ArrayBuffer} buffer
 * @param {string} contentType  e.g. 'audio/mpeg' or 'image/png'
 * @param {string} fileName     e.g. 'coaching.mp3'
 * @param {string} assetType    'audio' or 'image'
 * @param {string} apiKey
 * @returns {Promise<string>}   Hedra asset ID
 * @throws {Error}  Hedra upload error with status and response preview
 */
export async function hedraUploadAsset(buffer, contentType, fileName, assetType, apiKey) {
  const jsonHeaders = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  // Step 1: Create asset record
  let createResp;
  try {
    createResp = await fetch(`${HEDRA_BASE}/assets`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: fileName, type: assetType }),
    });
  } catch (e) {
    throw new Error(`Hedra create asset request failed: ${e.message}`);
  }

  if (!createResp.ok) {
    const err = await createResp.text().catch(() => '');
    throw new Error(`Hedra create asset error ${createResp.status}: ${err.substring(0, 200)}`);
  }

  const createData = await createResp.json();
  if (!createData.id) {
    throw new Error('Hedra create asset succeeded but no ID returned');
  }
  const assetId = createData.id;

  // Step 2: Upload file bytes
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: contentType }), fileName);

  let uploadResp;
  try {
    uploadResp = await fetch(`${HEDRA_BASE}/assets/${assetId}/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      // Note: no Content-Type — FormData sets it automatically with boundary
      body: formData,
    });
  } catch (e) {
    throw new Error(`Hedra upload file request failed: ${e.message}`);
  }

  if (!uploadResp.ok) {
    const err = await uploadResp.text().catch(() => '');
    throw new Error(`Hedra upload file error ${uploadResp.status}: ${err.substring(0, 200)}`);
  }

  return assetId;
}

/**
 * Start a Hedra lip-sync generation job.
 * @param {string} portraitAssetId  Pre-uploaded portrait asset ID (from HEDRA_COACH_PORTRAIT_ID secret)
 * @param {string} audioAssetId     Freshly uploaded audio asset ID
 * @param {string} apiKey
 * @returns {Promise<string>}       Hedra generation job ID
 * @throws {Error}  Hedra start job error with status and response preview
 */
export async function hedraStartJob(portraitAssetId, audioAssetId, apiKey) {
  const body = {
    type: 'video',
    ai_model_id: HEDRA_CHARACTER_3,
    start_keyframe_id: portraitAssetId,
    audio_id: audioAssetId,
    generated_video_inputs: {
      text_prompt: 'Natural speaking movement, professional career coaching, subtle hand gestures',
      ai_model_id: HEDRA_CHARACTER_3,
      resolution: '540p',
      aspect_ratio: '9:16',
    },
  };

  let response;
  try {
    response = await fetch(`${HEDRA_BASE}/generations`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Hedra start job request failed: ${e.message}`);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Hedra start job error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  if (!data.id) {
    throw new Error('Hedra start job succeeded but no generation ID returned');
  }

  return data.id;
}

/**
 * Get the current status of a Hedra generation job.
 * @param {string} hedraJobId
 * @param {string} apiKey
 * @returns {Promise<{status: string, videoUrl: string|null}>}
 *   status: 'complete' | 'error' | 'pending' | 'processing' (or other Hedra status strings)
 *   videoUrl: URL when status is 'complete', null otherwise
 * @throws {Error}  Hedra status error with status and response preview
 */
export async function hedraGetStatus(hedraJobId, apiKey) {
  let response;
  try {
    response = await fetch(`${HEDRA_BASE}/generations/${hedraJobId}/status`, {
      headers: { 'X-API-Key': apiKey },
    });
  } catch (e) {
    throw new Error(`Hedra status request failed: ${e.message}`);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Hedra status error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  if (!data.status) {
    throw new Error('Hedra status response missing status field');
  }

  // Video URL can appear at the top level or nested in batch_results
  const videoUrl = data.url || data.video_url
    || data.batch_results?.[0]?.url
    || data.batch_results?.[0]?.video_url
    || null;

  return { status: data.status, videoUrl };
}
