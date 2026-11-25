import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { notifyReady } from '../server.mjs';
import { verifyCleanImage } from '../src/verify.js';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

function vipsTool(tool) {
  return process.env.FRAMERINSE_VIPS_DIR ? path.join(process.env.FRAMERINSE_VIPS_DIR, tool) : tool;
}

function vips(tool, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(vipsTool(tool), args, { timeout: 60_000, ...options }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  });
}

// The CLI's own work folders go here (TMPDIR), never in the system's temp folder;
// it must be empty again after every run.
const cliTemp = await mkdtemp(path.join(tmpdir(), 'framerinse-cli-work-'));
test.after(() => rm(cliTemp, { force: true, recursive: true }));

// Runs the CLI; resolves with its exit code and output, never rejects on a non-zero exit.
function framerinse(args, env = process.env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...env, TMPDIR: cliTemp }, timeout: 120_000 }, async (error, stdout, stderr) => {
      assert.deepEqual(await readdir(cliTemp), [], 'the CLI removes its work folder');
      resolve({ code: error ? error.code : 0, stderr, stdout });
    });
  });
}

async function withTemp(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'framerinse-cli-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// A solid-colour image with no metadata, written to `file`.
async function solidImage(directory, file, { width, height, colour, saver }) {
  const black = path.join(directory, 'black.v');
  const coloured = path.join(directory, 'coloured.v');
  const typed = path.join(directory, 'typed.v');
  await vips('vips', ['black', black, String(width), String(height), '--bands', String(colour.length)]);
  await vips('vips', ['linear', black, coloured, colour.map(() => '1').join(' '), colour.join(' ')]);
  await vips('vips', ['cast', coloured, typed, 'uchar']);
  await vips('vips', [saver, typed, file, '--keep', 'none']);
  await Promise.all([black, coloured, typed].map((item) => rm(item)));
  return readFile(file);
}

function jpegSegment(marker, payload) {
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload]);
}

// EXIF with orientation 6 (rotate 90 degrees), a GPS directory, and maker notes.
function cameraExif() {
  const tiff = Buffer.alloc(96);
  const entry = (offset, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(value, offset + 8);
  };
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(3, 8);
  entry(10, 0x0112, 3, 1, 6);
  entry(22, 0x8769, 4, 1, 50);
  entry(34, 0x8825, 4, 1, 68);
  tiff.writeUInt32LE(0, 46);
  tiff.writeUInt16LE(1, 50);
  entry(52, 0x927c, 7, 8, 86);
  tiff.writeUInt32LE(0, 64);
  tiff.writeUInt16LE(1, 68);
  entry(70, 0x0001, 2, 2, 0x4e);
  tiff.writeUInt32LE(0, 82);
  tiff.write('MAKERNTE', 86, 'latin1');
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

// A 120x80 yellow JPEG that is upright at 80x120, with GPS, maker notes, and a comment.
async function cameraJpeg(directory) {
  const clean = await solidImage(directory, path.join(directory, 'plain.jpg'), { colour: [0xd9, 0xff, 0x67], height: 80, saver: 'jpegsave', width: 120 });
  const file = path.join(directory, 'camera.jpg');
  await writeFile(
    file,
    Buffer.concat([clean.subarray(0, 2), jpegSegment(0xe1, cameraExif()), jpegSegment(0xfe, Buffer.from('private comment')), clean.subarray(2)]),
  );
  return file;
}

async function decodePixels(file, directory) {
  const raw = path.join(directory, 'pixels.raw');
  const [width, channels] = await Promise.all(['width', 'bands'].map(async (field) => Number(await vips('vipsheader', ['-f', field, file]))));
  await vips('vips', ['rawsave', file, raw]);
  const data = await readFile(raw);
  await rm(raw);
  return (x, y) => data[(y * width + x) * channels];
}

test('check lists EXIF, GPS, maker notes, and comments, and exits 4', async () => {
  await withTemp(async (directory) => {
    const source = await cameraJpeg(directory);
    const text = await framerinse(['check', source]);
    assert.equal(text.code, 4, text.stderr);
    for (const kind of ['exif', 'gps', 'makernote', 'comment']) assert.match(text.stdout, new RegExp(`^  ${kind} `, 'm'));

    const json = await framerinse(['check', source, '--json']);
    assert.equal(json.code, 4);
    const report = JSON.parse(json.stdout);
    assert.equal(report.clean, false);
    assert.equal(report.container, 'jpeg');
    assert.equal(report.fullyChecked, true);
    assert.deepEqual(new Set(report.found.map((item) => item.kind)), new Set(['exif', 'gps', 'makernote', 'comment']));
  });
});

test('check finds an ICC profile, passes a bare image with exit 0, and refuses a non-image', async () => {
  await withTemp(async (directory) => {
    const plain = path.join(directory, 'plain.png');
    await solidImage(directory, plain, { colour: [10, 20, 30], height: 20, saver: 'pngsave', width: 30 });
    const bare = await framerinse(['check', plain, '--json']);
    assert.equal(bare.code, 0, bare.stdout);
    assert.deepEqual(JSON.parse(bare.stdout).found, []);

    const profiled = path.join(directory, 'profiled.jpg');
    await vips('vips', ['jpegsave', plain, profiled, '--profile', 'srgb']);
    const icc = await framerinse(['check', profiled, '--json']);
    assert.equal(icc.code, 4);
    assert.ok(JSON.parse(icc.stdout).found.some((item) => item.kind === 'icc'));

    const notImage = path.join(directory, 'notes.txt');
    await writeFile(notImage, 'not an image');
    const refused = await framerinse(['check', notImage]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Not an image/);
  });
});

test('clean rotates, covers, and re-encodes without metadata, and its output passes check', async () => {
  await withTemp(async (directory) => {
    const source = await cameraJpeg(directory);
    const output = path.join(directory, 'share.png');
    // A cover over the top-left 16x24 pixels of the upright 80x120 photo.
    const run = await framerinse(['clean', source, '-o', output, '--cover', '0,0,16,24', '--json']);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(
      [result.format, result.width, result.height, result.covers, result.check, result.source.metadata],
      ['png', 80, 120, 1, 'passed', 'detected'],
    );
    const bytes = await readFile(output);
    const verified = verifyCleanImage(bytes);
    assert.equal(verified.ok, true, verified.problems.join(', '));
    assert.deepEqual([verified.width, verified.height], [80, 120]);
    assert.equal(bytes.includes(Buffer.from('private comment')), false);
    const pixel = await decodePixels(output, directory);
    assert.ok(pixel(5, 5) < 25, 'covered pixels are dark');
    assert.ok(pixel(60, 100) > 150, 'uncovered pixels keep their colour');

    assert.equal((await framerinse(['check', output])).code, 0);

    // Default name next to the input, JPEG by default; never overwrites.
    const plainRun = await framerinse(['clean', source]);
    assert.equal(plainRun.code, 0, plainRun.stderr);
    assert.equal(verifyCleanImage(await readFile(path.join(directory, 'camera-clean.jpg'))).container, 'jpeg');
    const again = await framerinse(['clean', source]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists/);
  });
});

test('clean refuses bad covers and options without writing anything', async () => {
  await withTemp(async (directory) => {
    const source = await cameraJpeg(directory);
    const before = (await readdir(directory)).sort();
    const outside = await framerinse(['clean', source, '-o', path.join(directory, 'out.jpg'), '--cover', '70,100,20,30']);
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /outside the photo/);
    for (const args of [
      ['clean', source, '--cover', '1,2,3'],
      ['clean', source, '--format', 'gif'],
      ['clean', source, '--max-size', '500'],
      ['clean', source, '--quality', '30'],
      ['clean', source, '--unknown'],
      ['clean'],
      ['check', source, '--format', 'png'],
      ['launch'],
    ]) {
      const run = await framerinse(args);
      assert.equal(run.code, 2, args.join(' '));
    }
    const usage = await framerinse(['clean', '--json']);
    assert.equal(JSON.parse(usage.stdout).error.code, 'usage');
    assert.deepEqual((await readdir(directory)).sort(), before);
    assert.match((await framerinse(['--help'])).stdout, /framerinse clean IN/);
  });
});

test('clean exits 1 and writes nothing when the byte check fails', async () => {
  await withTemp(async (directory) => {
    // A vips that appends bytes after every JPEG it saves: the strict check must refuse it.
    const tools = path.join(directory, 'tools');
    const realVips = (await new Promise((resolve, reject) => {
      execFile('sh', ['-c', `command -v ${JSON.stringify(vipsTool('vips'))}`], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    })).trim();
    await mkdir(tools);
    const realDir = path.dirname(realVips);
    await writeFile(
      path.join(tools, 'vips'),
      `#!/bin/sh\n"${realDir}/vips" "$@" || exit $?\nif [ "$1" = jpegsave ]; then printf 'GPS 52N' >> "$3"; fi\n`,
    );
    await writeFile(path.join(tools, 'vipsheader'), `#!/bin/sh\nexec "${realDir}/vipsheader" "$@"\n`);
    await chmod(path.join(tools, 'vips'), 0o755);
    await chmod(path.join(tools, 'vipsheader'), 0o755);

    const source = await cameraJpeg(directory);
    const output = path.join(directory, 'out.jpg');
    const run = await framerinse(['clean', source, '-o', output, '--json'], { ...process.env, FRAMERINSE_VIPS_DIR: tools });
    assert.equal(run.code, 1);
    assert.match(JSON.parse(run.stdout).error.message, /did not pass the metadata check \(bytes after the end of the image\)/);
    assert.equal((await readdir(directory)).includes('out.jpg'), false);
  });
});

test('clean --decoy writes only the decoy EXIF, and check reports exactly its fields as exif, exit 4', async () => {
  await withTemp(async (directory) => {
    const source = await cameraJpeg(directory);
    const output = path.join(directory, 'decoy.jpg');
    const run = await framerinse(['clean', source, '-o', output, '--decoy', '--json']);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(result.decoy).sort(), ['DateTime', 'DateTimeOriginal', 'Make', 'Model']);
    assert.match(result.decoy.DateTimeOriginal, /^\d{4}:\d{2}:\d{2} 12:00:00$/);
    const bytes = await readFile(output);
    assert.equal(bytes.includes(Buffer.from('MAKERNTE')), false);
    assert.equal(bytes.includes(Buffer.from('private comment')), false);

    const json = await framerinse(['check', output, '--json']);
    assert.equal(json.code, 4);
    const report = JSON.parse(json.stdout);
    assert.deepEqual(report.found.map((item) => item.kind), ['exif']);
    assert.deepEqual(report.found[0].fields, result.decoy);
    const text = await framerinse(['check', output]);
    assert.equal(text.code, 4);
    assert.match(text.stdout, /^  exif +EXIF: only the decoy fields/m);
    assert.match(text.stdout, /^ +Model: iPhone 13$/m);

    // Off by default: the same command without --decoy gives a file check passes.
    const plain = path.join(directory, 'no-decoy.jpg');
    assert.equal((await framerinse(['clean', source, '-o', plain])).code, 0);
    assert.equal((await framerinse(['check', plain])).code, 0);

    for (const args of [
      ['clean', source, '-o', path.join(directory, 'x.png'), '--decoy'],
      ['clean', source, '--format', 'webp', '--decoy'],
      ['check', output, '--decoy'],
    ]) {
      const refused = await framerinse(args);
      assert.equal(refused.code, 2, args.join(' '));
    }
    assert.match((await framerinse(['clean', source, '--format', 'png', '--decoy'])).stderr, /JPEG only/);
  });
});

test('tells systemd it is ready only when NOTIFY_SOCKET is set', () => {
  const calls = [];
  const run = (...args) => calls.push(args.slice(0, 2));
  assert.equal(notifyReady({}, run), false);
  assert.deepEqual(calls, []);
  assert.equal(notifyReady({ NOTIFY_SOCKET: '/run/user/1000/systemd/notify' }, run), true);
  assert.deepEqual(calls, [['systemd-notify', ['--ready']]]);
});
