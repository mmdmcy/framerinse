import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { crc32 } from 'node:zlib';

import { createFrameRinseServer, defaultDataDir, parseOptions, publicFiles, securityHeaders } from '../server.mjs';
import { inspectImageMetadata } from '../src/metadata.js';
import { verifyCleanImage } from '../src/verify.js';

// Fixtures are made and decoded with the same libvips command line the server uses.
function vips(tool, args) {
  const command = process.env.FRAMERINSE_VIPS_DIR ? path.join(process.env.FRAMERINSE_VIPS_DIR, tool) : tool;
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000 }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  });
}

async function withScratch(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'framerinse-fixture-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// A solid-colour image saved with no metadata, as bytes.
function solidImage({ width, height, colour, saver, options = [] }) {
  return withScratch(async (directory) => {
    const black = path.join(directory, 'black.v');
    const coloured = path.join(directory, 'coloured.v');
    const typed = path.join(directory, 'typed.v');
    const output = path.join(directory, 'output');
    await vips('vips', ['black', black, String(width), String(height), '--bands', String(colour.length)]);
    await vips('vips', ['linear', black, coloured, colour.map(() => '1').join(' '), colour.join(' ')]);
    await vips('vips', ['cast', coloured, typed, 'uchar']);
    await vips('vips', [saver, typed, output, '--keep', 'none', ...options]);
    return readFile(output);
  });
}

// Decoded pixels of an image: { width, height, channels, data }.
function decodePixels(bytes) {
  return withScratch(async (directory) => {
    const input = path.join(directory, 'input');
    const raw = path.join(directory, 'pixels.raw');
    await writeFile(input, bytes);
    const [width, height, channels] = await Promise.all(
      ['width', 'height', 'bands'].map(async (field) => Number(await vips('vipsheader', ['-f', field, input]))),
    );
    await vips('vips', ['rawsave', input, raw]);
    return { channels, data: await readFile(raw), height, width };
  });
}

function pngChunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

// Adds private text, XMP, time, and EXIF chunks after a PNG's header.
function withPngMetadata(png) {
  const headerEnd = 8 + 25;
  return Buffer.concat([
    png.subarray(0, headerEnd),
    pngChunk('tEXt', Buffer.from('Author\0Private Person', 'latin1')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>GPS 52.37N</x:xmpmeta>', 'latin1')),
    pngChunk('tIME', Buffer.from([0x07, 0xea, 11, 18, 12, 34, 56])),
    pngChunk('eXIf', orientationExif(1).subarray(6)),
    png.subarray(headerEnd),
  ]);
}

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
  const clean = await solidImage({ colour: [0xd9, 0xff, 0x67], height: 80, saver: 'jpegsave', width: 120, options: ['--Q', '95'] });
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

test('defaults to plain HTTP LAN hosting and per-user SQLite state', () => {
  const options = parseOptions([], {});
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 4173);
  assert.equal(options.ttlMinutes, 60);
  assert.equal(options.maxTotalBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(options.dataDir, defaultDataDir({}));
  assert.equal(options.dataDir.startsWith(path.join(tmpdir(), 'framerinse')), false);
  assert.equal(defaultDataDir({ XDG_STATE_HOME: '/state' }), path.join('/state', 'framerinse'));
  assert.equal(parseOptions(['--host', '127.0.0.1', '--port', '8123', '--data-dir', '/tmp/p'], {}).host, '127.0.0.1');
  assert.equal(parseOptions(['--max-total-mb', '5'], {}).maxTotalBytes, 5 * 1024 * 1024);
  assert.equal(parseOptions([], { FRAMERINSE_MAX_TOTAL_MB: '7' }).maxTotalBytes, 7 * 1024 * 1024);
  assert.throws(() => parseOptions(['--max-total-mb', '0'], {}), /Total storage limit/);
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
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    const previewCheck = verifyCleanImage(previewBytes);
    assert.equal(previewCheck.ok, true, previewCheck.problems.join(', '));
    assert.equal(previewCheck.width, 80);
    assert.equal(previewCheck.height, 120);

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
      const verified = verifyCleanImage(bytes);
      assert.equal(verified.ok, true, verified.problems.join(', '));
      assert.deepEqual([verified.container, verified.width, verified.height], [format, 80, 120]);
      const decoded = await decodePixels(bytes);
      const pixel = (x, y) => decoded.data[(y * decoded.width + x) * decoded.channels];
      assert.ok(pixel(Math.round(output.width * 0.15), Math.round(output.height * 0.15)) < 25, 'solid cover should be dark in the output pixels');
      assert.ok(pixel(Math.round(output.width * 0.8), Math.round(output.height * 0.8)) > 150, 'uncovered pixels keep their colour');

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
    // Decoded straight from the original by libvips; no decoded copy is kept.
    await stat(path.join(dataDir, 'jobs', created.id, 'preview.jpg'));
    await assert.rejects(stat(path.join(dataDir, 'jobs', created.id, 'decoded.png')));

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

test('removes PNG text, XMP, time, and EXIF chunks from every export format', async () => {
  const png = withPngMetadata(await solidImage({ colour: [40, 90, 200, 255], height: 60, saver: 'pngsave', width: 90 }));
  assert.equal(inspectImageMetadata(png, 'image/png').hasSensitiveMetadata, true);
  assert.equal(verifyCleanImage(png).ok, false);
  await withServer(async (baseUrl) => {
    const upload = await fetch(`${baseUrl}/api/jobs`, { body: png, headers: { 'Content-Type': 'image/png' }, method: 'POST' });
    assert.equal(upload.status, 201);
    const created = await upload.json();
    assert.equal(created.source.metadataDetected, true);
    assert.equal(created.source.metadataStatus, 'detected');
    for (const format of ['png', 'jpeg', 'webp']) {
      const scrub = await fetch(`${baseUrl}/api/jobs/${created.id}/scrub`, {
        body: JSON.stringify({ covers: [], format, maxEdge: 1080, quality: 90 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      assert.equal(scrub.status, 200, format);
      const bytes = Buffer.from(await (await fetch(`${baseUrl}/api/jobs/${created.id}/output`)).arrayBuffer());
      const verified = verifyCleanImage(bytes);
      assert.equal(verified.ok, true, `${format}: ${verified.problems.join(', ')}`);
      assert.equal(bytes.includes(Buffer.from('Private Person')), false);
      assert.equal(bytes.includes(Buffer.from('xmpmeta')), false);
    }
  });
});

test('refuses an image over the pixel limit from its header, before decoding it', async () => {
  // 12000 x 9000 = 108 megapixels; the pixel data is not even valid.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(12000, 0);
  header.writeUInt32BE(9000, 4);
  header[8] = 8;
  header[9] = 2;
  const oversized = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  await withServer(async (baseUrl, _port, dataDir) => {
    const response = await fetch(`${baseUrl}/api/jobs`, { body: oversized, headers: { 'Content-Type': 'image/png' }, method: 'POST' });
    // The same answer as before the move to libvips: 415 with the decode message.
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: 'The server could not decode that photo format.' });
    assert.deepEqual(await readdir(path.join(dataDir, 'jobs')), []);
  });
});

test('names a raster format when given a vector or document file', async () => {
  await withServer(async (baseUrl) => {
    const svg = await fetch(`${baseUrl}/api/jobs`, {
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      headers: { 'Content-Type': 'image/svg+xml' },
      method: 'POST',
    });
    assert.equal(svg.status, 415);
    assert.match((await svg.json()).error, /Choose a raster photo/);
  });
});

test('refuses cross-site browser requests and non-image upload bodies', async () => {
  await withServer(async (baseUrl, port) => {
    const source = await sourceJpeg();
    const crossSite = await fetch(`${baseUrl}/api/jobs`, {
      body: source,
      headers: { 'Content-Type': 'image/jpeg', 'Sec-Fetch-Site': 'cross-site' },
      method: 'POST',
    });
    assert.equal(crossSite.status, 403);
    const foreignOrigin = await fetch(`${baseUrl}/api/jobs`, {
      body: source,
      headers: { 'Content-Type': 'image/jpeg', Origin: 'http://evil.example' },
      method: 'POST',
    });
    assert.equal(foreignOrigin.status, 403);
    const nullOrigin = await fetch(`${baseUrl}/api/jobs`, {
      body: source,
      headers: { 'Content-Type': 'image/jpeg', Origin: 'null' },
      method: 'POST',
    });
    assert.equal(nullOrigin.status, 403);
    const textPlain = await fetch(`${baseUrl}/api/jobs`, {
      body: source,
      headers: { 'Content-Type': 'text/plain' },
      method: 'POST',
    });
    assert.equal(textPlain.status, 415);

    const sameOrigin = await fetch(`${baseUrl}/api/jobs`, {
      body: source,
      headers: { 'Content-Type': 'image/jpeg', Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
      method: 'POST',
    });
    assert.equal(sameOrigin.status, 201);
    const created = await sameOrigin.json();
    const crossSiteDelete = await fetch(`${baseUrl}/api/jobs/${created.id}`, {
      headers: { Origin: 'http://evil.example' },
      method: 'DELETE',
    });
    assert.equal(crossSiteDelete.status, 403);
    assert.equal((await fetch(`${baseUrl}${created.previewUrl}`)).status, 200);
  });
});

test('caps total stored bytes across jobs', async () => {
  const sourceBytes = (await sourceJpeg()).length;
  await withServer(
    async (baseUrl) => {
      const first = await createJob(baseUrl);
      assert.equal(first.response.status, 201);
      const second = await createJob(baseUrl);
      assert.equal(second.response.status, 507);
      await fetch(`${baseUrl}/api/jobs/${first.body.id}`, { method: 'DELETE' });
      const third = await createJob(baseUrl);
      assert.equal(third.response.status, 201);
    },
    // Room for one source plus its preview, not for a second source.
    { maxTotalBytes: Math.floor(sourceBytes * 1.5) },
  );
});

test('tightens a pre-existing data directory to mode 0700', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'framerinse-mode-'));
  try {
    await mkdir(path.join(dataDir, 'jobs'));
    await chmod(dataDir, 0o755);
    await chmod(path.join(dataDir, 'jobs'), 0o777);
    const app = await createFrameRinseServer({ dataDir, ttlMinutes: 5 });
    app.close();
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dataDir, 'jobs'))).mode & 0o777, 0o700);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
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
