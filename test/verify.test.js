import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';

import { verifyCleanImage } from '../src/verify.js';

// Hand-made containers: just enough structure for the verifier to walk.

function jpegSegment(marker, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');
  const length = body.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), body]);
}

const JFIF = jpegSegment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
const DQT = jpegSegment(0xdb, Buffer.alloc(65));
// SOF0: 8-bit, 40 high, 60 wide, one component.
const SOF = jpegSegment(0xc0, Buffer.from([8, 0, 40, 0, 60, 1, 1, 0x11, 0]));
const DHT = jpegSegment(0xc4, Buffer.alloc(20));
const SOS = jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
// Entropy-coded bytes with a stuffed 0xFF00 and a restart marker.
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]);

function jpeg(...extra) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, ...extra, DQT, SOF, DHT, SOS, SCAN, Buffer.from([0xff, 0xd9])]);
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

function png(...extra) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(30, 0);
  header.writeUInt32BE(20, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('pHYs', Buffer.alloc(9)),
    ...extra,
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00])),
    pngChunk('IEND'),
  ]);
}

function webpChunk(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const header = Buffer.alloc(8);
  header.write(type, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webp(...chunks) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// VP8 key frame header for a 30 x 20 image.
const VP8 = webpChunk('VP8 ', Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 30, 0, 20, 0, 0, 0]));

function vp8x(flags) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(30 - 1, 4, 3);
  data.writeUIntLE(20 - 1, 7, 3);
  return webpChunk('VP8X', data);
}

test('accepts a JPEG made of JFIF, tables, one frame, and one scan', () => {
  const result = verifyCleanImage(jpeg());
  assert.deepEqual(result, { container: 'jpeg', height: 40, ok: true, problems: [], width: 60 });
});

test('refuses JPEG EXIF, XMP, ICC, IPTC, other APPn, and comments', () => {
  const cases = [
    [jpegSegment(0xe1, 'Exif\0\0II*\0'), 'exif'],
    [jpegSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'), 'xmp'],
    [jpegSegment(0xe2, 'ICC_PROFILE\0\x01\x01profile'), 'icc'],
    [jpegSegment(0xed, 'Photoshop 3.0\x008BIM'), 'iptc'],
    [jpegSegment(0xee, 'Adobe\0'), 'app'],
    [jpegSegment(0xef, 'anything'), 'app'],
    [jpegSegment(0xfe, 'shot at home'), 'comment'],
  ];
  for (const [segment, kind] of cases) {
    const result = verifyCleanImage(jpeg(segment));
    assert.equal(result.ok, false, kind);
    assert.deepEqual(result.problems, [kind]);
  }
});

test('refuses a JFIF header carrying a thumbnail, and a second JFIF header', () => {
  const thumbnail = jpegSegment(0xe0, Buffer.concat([Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 2, 2]), Buffer.alloc(12)]));
  const withThumbnail = Buffer.concat([Buffer.from([0xff, 0xd8]), thumbnail, DQT, SOF, DHT, SOS, SCAN, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(verifyCleanImage(withThumbnail).problems, ['app']);
  assert.deepEqual(verifyCleanImage(jpeg(JFIF)).problems, ['app']);
});

test('refuses JPEG metadata after the scan, bytes after the end, and truncation', () => {
  const late = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    JFIF,
    DQT,
    SOF,
    DHT,
    SOS,
    SCAN,
    jpegSegment(0xe1, 'Exif\0\0late'),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.deepEqual(verifyCleanImage(late).problems, ['exif']);
  assert.deepEqual(verifyCleanImage(Buffer.concat([jpeg(), Buffer.from('GPS')])).problems, ['bytes after the end of the image']);
  assert.equal(verifyCleanImage(jpeg().subarray(0, 60)).ok, false);
  const noScan = Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, DQT, SOF, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(verifyCleanImage(noScan).problems, ['no image data']);
});

test('accepts a PNG made of header, resolution, data, and end', () => {
  assert.deepEqual(verifyCleanImage(png()), { container: 'png', height: 20, ok: true, problems: [], width: 30 });
  assert.equal(verifyCleanImage(png(pngChunk('sRGB', Buffer.from([0])), pngChunk('gAMA', Buffer.alloc(4)))).ok, true);
});

test('refuses PNG eXIf, text, iCCP, tIME, and unknown chunks', () => {
  const cases = [
    [pngChunk('eXIf', 'II*\0'), 'exif'],
    [pngChunk('tEXt', 'Author\0Someone'), 'text'],
    [pngChunk('zTXt', 'Comment\0\0x'), 'text'],
    [pngChunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x/>'), 'text'],
    [pngChunk('iCCP', 'Display P3\0\0x'), 'icc'],
    [pngChunk('tIME', Buffer.from([7, 234, 11, 18, 12, 0, 0])), 'timestamp'],
    [pngChunk('prVt', 'private'), 'unknown chunk "prVt"'],
    [pngChunk('acTL', Buffer.alloc(8)), 'unknown chunk "acTL"'],
  ];
  for (const [chunk, kind] of cases) {
    const result = verifyCleanImage(png(chunk));
    assert.equal(result.ok, false, kind);
    assert.deepEqual(result.problems, [kind]);
  }
});

test('refuses a PNG with a bad checksum, bytes after IEND, or no IEND', () => {
  const bad = png();
  bad[bad.length - 20] ^= 0xff;
  assert.equal(verifyCleanImage(bad).ok, false);
  assert.deepEqual(verifyCleanImage(Buffer.concat([png(), Buffer.from('trailer')])).problems, ['bytes after the end of the image']);
  assert.equal(verifyCleanImage(png().subarray(0, -12)).ok, false);
});

test('accepts simple and extended WebP with alpha only', () => {
  assert.deepEqual(verifyCleanImage(webp(VP8)), { container: 'webp', height: 20, ok: true, problems: [], width: 30 });
  const alpha = verifyCleanImage(webp(vp8x(0x10), webpChunk('ALPH', Buffer.alloc(5)), VP8));
  assert.deepEqual([alpha.ok, alpha.width, alpha.height], [true, 30, 20]);
});

test('refuses WebP EXIF, XMP, ICCP chunks and flags, animation, and unknown chunks', () => {
  assert.deepEqual(verifyCleanImage(webp(vp8x(0), VP8, webpChunk('EXIF', 'II*\0'))).problems, ['exif']);
  assert.deepEqual(verifyCleanImage(webp(vp8x(0), VP8, webpChunk('XMP ', '<x/>'))).problems, ['xmp']);
  assert.deepEqual(verifyCleanImage(webp(vp8x(0), webpChunk('ICCP', 'profile'), VP8)).problems, ['icc']);
  assert.deepEqual(verifyCleanImage(webp(vp8x(0x20 | 0x08 | 0x04), VP8)).problems, ['icc', 'exif', 'xmp']);
  assert.deepEqual(verifyCleanImage(webp(vp8x(0x02), webpChunk('ANIM', Buffer.alloc(6)), VP8)).problems, ['animation']);
  assert.deepEqual(verifyCleanImage(webp(VP8, webpChunk('JUNK', 'x'))).problems, ['unknown chunk "JUNK"']);
  assert.deepEqual(verifyCleanImage(webp(VP8, VP8)).problems, ['not exactly one image']);
});

test('refuses a WebP whose RIFF size does not match, and anything not JPEG, PNG, or WebP', () => {
  assert.equal(verifyCleanImage(Buffer.concat([webp(VP8), Buffer.from('xx')])).ok, false);
  assert.equal(verifyCleanImage(Buffer.from('GIF89a......')).ok, false);
  assert.equal(verifyCleanImage(Buffer.from('<svg/>')).container, 'unknown');
});
