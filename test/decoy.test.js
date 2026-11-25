import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decoyDay, decoySegment, decoyTiff, findDecoy, insertDecoy } from '../src/decoy.js';
import { cleanImage, inspectFile, readSource, validateScrubSettings } from '../src/pipeline.js';
import { verifyCleanImage } from '../src/verify.js';
import { renderImage } from '../src/vips.js';

const DAY = '2026:11:25';

function vipsTool(tool) {
  return process.env.FRAMERINSE_VIPS_DIR ? path.join(process.env.FRAMERINSE_VIPS_DIR, tool) : tool;
}

function vips(tool, args) {
  return new Promise((resolve, reject) => {
    execFile(vipsTool(tool), args, { timeout: 60_000 }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  });
}

async function withTemp(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'framerinse-decoy-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// A 120x80 solid JPEG with no metadata.
async function plainJpeg(directory) {
  const black = path.join(directory, 'black.v');
  const file = path.join(directory, 'plain.jpg');
  await vips('vips', ['black', black, '120', '80', '--bands', '3']);
  await vips('vips', ['jpegsave', black, file, '--keep', 'none']);
  await rm(black);
  return file;
}

function jpegSegment(marker, payload) {
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload]);
}

// A big-endian EXIF block from directories of [tag, type, value] entries
// (type 2 ASCII with a string value, 4 LONG with a number or 'ifdN', the
// offset of directory N), to make the
// tampered variants the verifier must refuse.
function exifPayload(directories) {
  const sizes = directories.map((entries) => 2 + entries.length * 12 + 4);
  const starts = sizes.map((_size, index) => 8 + sizes.slice(0, index).reduce((sum, size) => sum + size, 0));
  let dataOffset = starts.at(-1) + sizes.at(-1);
  const strings = [];
  const tiff = Buffer.alloc(4096);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  directories.forEach((entries, index) => {
    let at = starts[index];
    tiff.writeUInt16BE(entries.length, at);
    at += 2;
    for (const [tag, type, value] of entries) {
      tiff.writeUInt16BE(tag, at);
      tiff.writeUInt16BE(type, at + 2);
      if (type === 2) {
        const text = Buffer.from(`${value}\0`, 'latin1');
        tiff.writeUInt32BE(text.length, at + 4);
        tiff.writeUInt32BE(dataOffset, at + 8);
        strings.push([dataOffset, text]);
        dataOffset += text.length + (text.length % 2);
      } else {
        tiff.writeUInt32BE(1, at + 4);
        tiff.writeUInt32BE(typeof value === 'string' ? starts[Number(value.slice(3))] : value, at + 8);
      }
      at += 12;
    }
    tiff.writeUInt32BE(0, at);
  });
  for (const [offset, text] of strings) text.copy(tiff, offset);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.subarray(0, dataOffset)]);
}

const DATE = `${DAY} 12:00:00`;
const IFD0 = [
  [0x010f, 2, 'Apple'],
  [0x0110, 2, 'iPhone 13'],
  [0x0132, 2, DATE],
];

test('the decoy writer makes exactly Make, Model, DateTime and DateTimeOriginal, read back by libvips', async () => {
  // Our generic builder, given the four fields, makes the same bytes as the writer.
  const rebuilt = exifPayload([[...IFD0, [0x8769, 4, 'ifd1']], [[0x9003, 2, DATE]]]);
  assert.deepEqual(decoySegment(DAY).subarray(4), rebuilt);
  assert.deepEqual(decoyTiff(DAY), rebuilt.subarray(6));
  assert.equal(decoySegment(DAY).length, decoySegment('1999:01:02').length, 'fixed size, whatever the day');
  assert.equal(decoyDay(new Date(2026, 0, 5, 23, 59)), '2026:01:05');
  assert.throws(() => decoySegment('2026-11-25'), /YYYY:MM:DD/);

  // Walked back independently: every entry of every directory the TIFF links to.
  const tiff = decoyTiff(DAY);
  const entries = [];
  const walk = (offset, name) => {
    for (let index = 0; index < tiff.readUInt16BE(offset); index += 1) {
      const at = offset + 2 + index * 12;
      const tag = tiff.readUInt16BE(at);
      const count = tiff.readUInt32BE(at + 4);
      const value = tiff.readUInt32BE(at + 8);
      if (tag === 0x8769) walk(value, 'exif');
      else entries.push(`${name} 0x${tag.toString(16)} ${tiff.subarray(value, value + count - 1).toString('latin1')}`);
    }
    assert.equal(tiff.readUInt32BE(offset + 2 + tiff.readUInt16BE(offset) * 12), 0, `${name} links to no further directory (no thumbnail)`);
  };
  walk(tiff.readUInt32BE(4), 'ifd0');
  assert.deepEqual(entries, ['ifd0 0x10f Apple', 'ifd0 0x110 iPhone 13', `ifd0 0x132 ${DATE}`, `exif 0x9003 ${DATE}`]);

  // And by libvips, whose EXIF library also lists the mandatory defaults it
  // assumes (resolution, ExifVersion, ColorSpace): those are not in the bytes.
  await withTemp(async (directory) => {
    const file = path.join(directory, 'decoy.jpg');
    await writeFile(file, insertDecoy(await readFile(await plainJpeg(directory)), decoySegment(DAY)));
    const fields = Object.fromEntries(
      (await vips('vipsheader', ['-a', file]))
        .split('\n')
        .filter((line) => line.startsWith('exif-ifd'))
        .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
    );
    assert.match(fields['exif-ifd0-Make'], /^Apple /);
    assert.match(fields['exif-ifd0-Model'], /^iPhone 13 /);
    assert.match(fields['exif-ifd0-DateTime'], /^2026:11:25 12:00:00 /);
    assert.match(fields['exif-ifd2-DateTimeOriginal'], /^2026:11:25 12:00:00 /);
    // No Orientation tag: the pixels are upright, and an absent tag means 1.
    assert.equal(Object.keys(fields).some((name) => /^exif-ifd[13]-|MakerNote|Serial|GPS|Software|Orientation/.test(name)), false, Object.keys(fields).join());
  });
});

test('the verifier accepts exactly the decoy segment the writer made, and refuses tampering', async () => {
  await withTemp(async (directory) => {
    const plain = await readFile(await plainJpeg(directory));
    const decoy = decoySegment(DAY);
    const withDecoy = insertDecoy(plain, decoy);
    assert.equal(verifyCleanImage(withDecoy, { decoy }).ok, true);
    assert.deepEqual(findDecoy(withDecoy).segment, decoy);

    // Without the option the decoy is plain EXIF; the option on a file without it fails.
    assert.deepEqual(verifyCleanImage(withDecoy).problems, ['exif']);
    assert.deepEqual(verifyCleanImage(plain, { decoy }).problems, ['not the expected decoy EXIF']);
    // Another day's decoy is not this one.
    assert.equal(verifyCleanImage(insertDecoy(plain, decoySegment('2026:11:24')), { decoy }).ok, false);

    const tampered = {
      'an extra field (Software)': exifPayload([[IFD0[0], IFD0[1], [0x0131, 2, 'Editor 1.0'], IFD0[2], [0x8769, 4, 'ifd1']], [[0x9003, 2, DATE]]]),
      'a GPS directory': exifPayload([[...IFD0, [0x8769, 4, 'ifd1'], [0x8825, 4, 'ifd2']], [[0x9003, 2, DATE]], [[0x0001, 2, 'N']]]),
      'a serial number': exifPayload([[...IFD0, [0x8769, 4, 'ifd1']], [[0x9003, 2, DATE], [0xa431, 2, 'C39XK0001']]]),
      'another model': exifPayload([[[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 14'], [0x0132, 2, DATE], [0x8769, 4, 'ifd1']], [[0x9003, 2, DATE]]]),
    };
    for (const [name, payload] of Object.entries(tampered)) {
      const file = insertDecoy(plain, jpegSegment(0xe1, payload));
      const verified = verifyCleanImage(file, { decoy });
      assert.equal(verified.ok, false, name);
      assert.deepEqual(verified.problems, ['not the expected decoy EXIF'], name);
      assert.equal(findDecoy(file), null, name);
    }

    // The exact decoy followed by a second EXIF segment, or a comment, still fails.
    const gps = exifPayload([[[0x8825, 4, 'ifd1']], [[0x0001, 2, 'N']]]);
    assert.deepEqual(verifyCleanImage(insertDecoy(insertDecoy(plain, jpegSegment(0xe1, gps)), decoy), { decoy }).problems, ['exif']);
    assert.deepEqual(verifyCleanImage(insertDecoy(insertDecoy(plain, jpegSegment(0xfe, Buffer.from('hi'))), decoy), { decoy }).problems, ['comment']);
    // Only JPEG carries the decoy.
    assert.equal(verifyCleanImage(Buffer.from('RIFF\x0c\0\0\0WEBPVP8 ', 'latin1'), { decoy }).ok, false);
  });
});

test('the pipeline: decoy off is byte for byte the render alone; on, the same bytes plus the decoy after SOI', async () => {
  await withTemp(async (directory) => {
    const source = await plainJpeg(directory);
    const info = await readSource(source, directory);
    const clean = async (name, settings) => {
      const output = path.join(directory, name);
      const result = await cleanImage({
        now: new Date(2026, 10, 25, 18, 47, 3),
        output,
        settings: validateScrubSettings({ covers: [], format: 'jpeg', maxEdge: 1080, quality: 90, ...settings }),
        source,
        sourceFormat: info.format,
        sourceHeight: info.height,
        sourceWidth: info.width,
      });
      return { bytes: await readFile(output), result };
    };

    // What the pipeline produced before the decoy existed: the render, unchanged.
    const before = path.join(directory, 'before.jpg');
    await renderImage({
      autorotate: true,
      covers: [],
      flatten: true,
      height: 80,
      loader: info.loader,
      output: before,
      save: { format: 'jpeg', progressive: true, quality: 90 },
      source,
      sourceHeight: info.height,
      sourceWidth: info.width,
      width: 120,
    });
    const reference = await readFile(before);

    const omitted = await clean('omitted.jpg', {});
    const off = await clean('off.jpg', { decoy: false });
    const on = await clean('on.jpg', { decoy: true });
    assert.deepEqual(omitted.bytes, reference);
    assert.deepEqual(off.bytes, reference);
    assert.equal(off.result.decoy, null);
    assert.deepEqual(on.bytes, insertDecoy(reference, decoySegment(DAY)), 'real time 18:47:03 is written as the day at noon');
    assert.deepEqual(on.result.decoy, { DateTime: '2026:11:25 12:00:00', DateTimeOriginal: '2026:11:25 12:00:00', Make: 'Apple', Model: 'iPhone 13' });
    assert.equal(on.result.bytes, on.bytes.length);

    // check: the decoy output carries exif, exactly the decoy's fields, and nothing else.
    const report = await inspectFile(path.join(directory, 'on.jpg'), directory);
    assert.deepEqual(report.found.map((item) => item.kind), ['exif']);
    assert.deepEqual(report.found[0].fields, on.result.decoy);
    assert.deepEqual((await inspectFile(path.join(directory, 'off.jpg'), directory)).found, []);

    for (const settings of [{ decoy: true, format: 'png' }, { decoy: true, format: 'webp' }, { decoy: 'yes' }, { decoy: 1 }]) {
      assert.throws(() => validateScrubSettings({ covers: [], ...settings }), (error) => error.status === 400, JSON.stringify(settings));
    }
  });
});
