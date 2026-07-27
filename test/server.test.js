import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import sharp from 'sharp';

import { createFrameRinseServer, parseOptions, publicFiles, securityHeaders } from '../server.mjs';
import { inspectImageMetadata } from '../src/metadata.js';

async function withServer(run, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'framerinse-test-'));
  const app = await createFrameRinseServer({ dataDir, ttlMinutes: 5, ...options });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, address.port, dataDir);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.close();
    await rm(dataDir, { force: true, recursive: true });
  }
}

function rawRequest(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', method, path: requestPath, port }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ body: Buffer.concat(chunks), response }));
    });
    request.on('error', reject);
    request.end();
  });
}

function jpegSegment(marker, payload) {
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload]);
}

function orientationExif(orientation) {
  const payload = Buffer.alloc(32);
  payload.write('Exif\0\0', 0, 'binary');
  payload.write('II', 6, 'ascii');
  payload.writeUInt16LE(42, 8);
  payload.writeUInt32LE(8, 10);
  payload.writeUInt16LE(1, 14);
  payload.writeUInt16LE(0x0112, 16);
  payload.writeUInt16LE(3, 18);
  payload.writeUInt32LE(1, 20);
  payload.writeUInt16LE(orientation, 24);
  payload.writeUInt16LE(0, 26);
  payload.writeUInt32LE(0, 28);
  return payload;
}

async function sourceJpeg() {
  const clean = await sharp({
    create: { background: '#d9ff67', channels: 3, height: 80, width: 120 },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  return Buffer.concat([
    clean.subarray(0, 2),
    jpegSegment(0xe1, orientationExif(6)),
    jpegSegment(0xfe, Buffer.from('private source comment')),
    clean.subarray(2),
  ]);
}

const sourceHeic = Buffer.from(
  [
    'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAX1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAA',
    'Imlsb2MAAAAAREAAAQABAAAAAAGhAAEAAAAAAAAANwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAA/WlwcnAAAADdaXBjbwAAAHZodmND',
    'AQNwAAAAAAAAAAAAHvAA/P34+AAADwMgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQCEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAA',
    'AAMAgAAAAwCEIgABAAZEAcFzwYkAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAADAAAAAEAAAAIAAAAAf///8wAAAAC////yAAAAAIAAAATY29scm5j',
    'bHgAAQANAAaAAAAAEHBpeGkAAAAAAwgICAAAABhpcG1hAAAAAAAAAAEAAQWBAoMEBQAAAD9tZGF0AAAAMygBrwYyFoc0iSDlv9jov//+bX//7/as1snrhH6A',
    'Y8fkt5CRnvRfexhS5Tx0IPScU7nNgA==',
  ].join(''),
  'base64',
);

async function createJob(baseUrl) {
  const source = await sourceJpeg();
  const response = await fetch(`${baseUrl}/api/jobs`, {
    body: source,
    headers: { 'Content-Type': 'image/jpeg' },
    method: 'POST',
  });
  return { body: await response.json(), response, source };
}

test('defaults to plain HTTP LAN hosting and temporary SQLite state', () => {
  const options = parseOptions([], {});
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 4173);
  assert.equal(options.ttlMinutes, 60);
  assert.equal(options.dataDir, path.join(tmpdir(), 'framerinse'));
  assert.equal(parseOptions(['--host', '127.0.0.1', '--port', '8123', '--data-dir', '/tmp/p'], {}).host, '127.0.0.1');
  assert.throws(() => parseOptions(['--port', '70000'], {}), /Port must be/);
  assert.throws(() => parseOptions(['--unknown'], {}), /Unknown option/);
});

test('serves the app shell with self-hosted API access and restrictive headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    const html = await response.text();
    assert.match(html, /FrameRinse/);
    assert.match(html, /Your server does the work/);
  });
});

test('uploads, auto-orients, previews, scrubs all formats, and clears a SQLite job', async () => {
  await withServer(async (baseUrl, _port, dataDir) => {
    const created = await createJob(baseUrl);
    assert.equal(created.response.status, 201);
    assert.equal(created.body.source.width, 80);
    assert.equal(created.body.source.height, 120);
    assert.equal(created.body.source.metadataDetected, true);
    assert.equal(created.body.source.format, 'jpeg');
    await stat(path.join(dataDir, 'framerinse.sqlite'));

    const preview = await fetch(`${baseUrl}${created.body.previewUrl}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/jpeg');
    const previewMetadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    assert.equal(previewMetadata.width, 80);
    assert.equal(previewMetadata.height, 120);

    for (const format of ['jpeg', 'png', 'webp']) {
      const scrubResponse = await fetch(`${baseUrl}/api/jobs/${created.body.id}/scrub`, {
        body: JSON.stringify({
          covers: [{ height: 0.2, width: 0.2, x: 0.1, y: 0.1 }],
          format,
          maxEdge: 1080,
          quality: 90,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      assert.equal(scrubResponse.status, 200);
      const output = await scrubResponse.json();
      assert.equal(output.format, format);
      assert.equal(output.width, 80);
      assert.equal(output.height, 120);
      assert.equal(output.coverCount, 1);

      const fileResponse = await fetch(`${baseUrl}${output.outputUrl}`);
      const bytes = Buffer.from(await fileResponse.arrayBuffer());
      const inspection = inspectImageMetadata(bytes, fileResponse.headers.get('content-type'));
      assert.equal(inspection.fullyChecked, true);
      assert.equal(inspection.hasSensitiveMetadata, false);
      const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      const sampleOffset = (Math.round(output.height * 0.15) * output.width + Math.round(output.width * 0.15)) * decoded.info.channels;
      assert.ok(decoded.data[sampleOffset] < 25, 'solid cover should be dark in the output pixels');

      const download = await fetch(`${baseUrl}${output.downloadUrl}`);
      assert.match(download.headers.get('content-disposition'), /^attachment; filename="framerinse\./);
    }

    const cleared = await fetch(`${baseUrl}/api/jobs/${created.body.id}`, { method: 'DELETE' });
    assert.equal(cleared.status, 204);
    assert.equal((await fetch(`${baseUrl}${created.body.previewUrl}`)).status, 404);
  });
});

test('decodes HEIC on the server and exports a clean JPEG', async () => {
  await withServer(async (baseUrl, _port, dataDir) => {
    const uploadResponse = await fetch(`${baseUrl}/api/jobs`, {
      body: sourceHeic,
      headers: { 'Content-Type': 'image/heic' },
      method: 'POST',
    });
    assert.equal(uploadResponse.status, 201);
    const created = await uploadResponse.json();
    assert.deepEqual(
      {
        format: created.source.format,
        height: created.source.height,
        metadataStatus: created.source.metadataStatus,
        width: created.source.width,
      },
      { format: 'heic', height: 8, metadataStatus: 'not-fully-checked', width: 12 },
    );
    await stat(path.join(dataDir, 'jobs', created.id, 'decoded.png'));

    const scrubResponse = await fetch(`${baseUrl}/api/jobs/${created.id}/scrub`, {
      body: JSON.stringify({ covers: [], format: 'jpeg', maxEdge: 1080, quality: 90 }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.equal(scrubResponse.status, 200);
    const scrubbed = await scrubResponse.json();
    const outputResponse = await fetch(`${baseUrl}${scrubbed.outputUrl}`);
    const output = Buffer.from(await outputResponse.arrayBuffer());
    assert.equal(inspectImageMetadata(output, 'image/jpeg').hasSensitiveMetadata, false);
  });
});

test('rejects invalid image uploads and unsafe scrub settings', async () => {
  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/jobs`, { body: 'not an image', method: 'POST' });
    assert.equal(invalid.status, 415);

    const created = await createJob(baseUrl);
    const invalidCover = await fetch(`${baseUrl}/api/jobs/${created.body.id}/scrub`, {
      body: JSON.stringify({ covers: [{ height: 1, width: 1, x: 0.5, y: 0.5 }], format: 'jpeg' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.equal(invalidCover.status, 400);
  });
});

test('does not expose server source, database, private state, or path traversal', async () => {
  await withServer(async (baseUrl, port) => {
    assert.equal((await fetch(`${baseUrl}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/framerinse.sqlite`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/.env`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/docs/architecture.md`)).status, 404);
    assert.equal((await rawRequest(port, '/%2e%2e/server.mjs')).response.statusCode, 404);
  });
});

test('HEAD returns static headers without a response body', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/src/app.js`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });
});

test('every public file keeps cross-origin and sensor access disabled', () => {
  assert.equal(publicFiles.size, 4);
  for (const fileName of publicFiles.keys()) {
    const headers = securityHeaders(fileName);
    assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(headers['Permissions-Policy'].includes('geolocation=()'), true);
  }
});
