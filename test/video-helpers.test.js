/**
 * video-helpers.test.js
 * Tests for _video-helpers.js with mocked fetch.
 * Usage: node test/video-helpers.test.js
 */

import { callElevenLabs, hedraUploadAsset, hedraStartJob, hedraGetStatus }
  from '../functions/_video-helpers.js';

// ─── Test harness ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  FAIL: ${label}`);
    failed++;
  }
}

async function test(label, fn) {
  console.log(`\n▶ ${label}`);
  try {
    await fn();
  } catch (e) {
    console.error(`  ❌  THREW: ${e.message}`);
    failed++;
  }
}

// ─── Fetch mock ────────────────────────────────────────────────────────────
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

// ─── callElevenLabs Tests ──────────────────────────────────────────────────

await test('callElevenLabs — success returns ArrayBuffer', async () => {
  installMockFetch();
  const testBuffer = new ArrayBuffer(1024);
  enqueueMock({ ok: true, arrayBuffer: testBuffer });

  const result = await callElevenLabs('Test script', 'test-api-key');

  assert(result === testBuffer, 'returns the ArrayBuffer from response');
  uninstallMockFetch();
});

await test('callElevenLabs — API error throws with status code', async () => {
  installMockFetch();
  enqueueMock({ ok: false, status: 401, text: 'Unauthorized' });

  let threw = false;
  let errorMessage = '';
  try {
    await callElevenLabs('Test script', 'invalid-key');
  } catch (e) {
    threw = true;
    errorMessage = e.message;
  }

  assert(threw === true, 'throws on API error');
  assert(errorMessage.includes('401'), `error message includes '401' (got: ${errorMessage})`);
  uninstallMockFetch();
});

// ─── hedraUploadAsset Tests ────────────────────────────────────────────────

await test('hedraUploadAsset — success returns asset ID', async () => {
  installMockFetch();
  enqueueMock({ ok: true, json: { id: 'asset-abc123' } });

  const buffer = new ArrayBuffer(512);
  const result = await hedraUploadAsset(buffer, 'audio/mpeg', 'test.mp3', 'test-key');

  assert(result === 'asset-abc123', 'returns the asset ID');
  uninstallMockFetch();
});

await test('hedraUploadAsset — API error throws', async () => {
  installMockFetch();
  enqueueMock({ ok: false, status: 500, text: 'Internal Server Error' });

  let threw = false;
  let errorMessage = '';
  try {
    const buffer = new ArrayBuffer(512);
    await hedraUploadAsset(buffer, 'audio/mpeg', 'test.mp3', 'test-key');
  } catch (e) {
    threw = true;
    errorMessage = e.message;
  }

  assert(threw === true, 'throws on API error');
  assert(errorMessage.includes('500'), `error message includes '500' (got: ${errorMessage})`);
  uninstallMockFetch();
});

// ─── hedraStartJob Tests ───────────────────────────────────────────────────

await test('hedraStartJob — success returns jobId', async () => {
  installMockFetch();
  enqueueMock({ ok: true, json: { jobId: 'job-xyz789' } });

  const result = await hedraStartJob('portrait-id', 'audio-id', 'test-key');

  assert(result === 'job-xyz789', 'returns the job ID');
  uninstallMockFetch();
});

await test('hedraStartJob — API error throws', async () => {
  installMockFetch();
  enqueueMock({ ok: false, status: 422, text: 'Invalid asset' });

  let threw = false;
  let errorMessage = '';
  try {
    await hedraStartJob('portrait-id', 'audio-id', 'test-key');
  } catch (e) {
    threw = true;
    errorMessage = e.message;
  }

  assert(threw === true, 'throws on API error');
  assert(errorMessage.includes('422'), `error message includes '422' (got: ${errorMessage})`);
  uninstallMockFetch();
});

// ─── hedraGetStatus Tests ──────────────────────────────────────────────────

await test('hedraGetStatus — completed returns status and videoUrl', async () => {
  installMockFetch();
  enqueueMock({
    ok: true,
    json: {
      status: 'completed',
      videoUrl: 'https://cdn.hedra.ai/video.mp4'
    }
  });

  const result = await hedraGetStatus('job-123', 'test-key');

  assert(result.status === 'completed', `status is 'completed' (got: ${result.status})`);
  assert(result.videoUrl === 'https://cdn.hedra.ai/video.mp4',
    `videoUrl is correct (got: ${result.videoUrl})`);
  uninstallMockFetch();
});

await test('hedraGetStatus — processing returns null videoUrl', async () => {
  installMockFetch();
  enqueueMock({
    ok: true,
    json: {
      status: 'processing'
    }
  });

  const result = await hedraGetStatus('job-456', 'test-key');

  assert(result.status === 'processing', `status is 'processing' (got: ${result.status})`);
  assert(result.videoUrl === null, `videoUrl is null (got: ${result.videoUrl})`);
  uninstallMockFetch();
});

await test('hedraGetStatus — API error throws', async () => {
  installMockFetch();
  enqueueMock({ ok: false, status: 404, text: 'Not Found' });

  let threw = false;
  let errorMessage = '';
  try {
    await hedraGetStatus('job-nonexistent', 'test-key');
  } catch (e) {
    threw = true;
    errorMessage = e.message;
  }

  assert(threw === true, 'throws on API error');
  assert(errorMessage.includes('404'), `error message includes '404' (got: ${errorMessage})`);
  uninstallMockFetch();
});

// ─── Final Report ─────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('❌  TESTS FAILED — do not deploy');
  process.exit(1);
} else {
  console.log('✅  ALL TESTS PASSED — safe to proceed');
  process.exit(0);
}
