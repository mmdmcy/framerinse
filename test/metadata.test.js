import assert from 'node:assert/strict';
import test from 'node:test';

import { detectContainer, formatBytes, inspectImageMetadata, readImageDimensions } from '../src/metadata.js';

const encoder = new TextEncoder();

function join(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function jpegSegment(marker, payloadText) {
  const payload = encoder.encode(payloadText);
  const length = payload.length + 2;
  return new Uint8Array([0xff, marker, length >> 8, length & 0xff, ...payload]);
}

function jpegWith(...segments) {
  return join(new Uint8Array([0xff, 0xd8]), ...segments, new Uint8Array([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
}

function uint32(value, littleEndian = false) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, littleEndian);
  return bytes;
}

function pngChunk(type, payloadText = '') {
  const payload = encoder.encode(payloadText);
  return join(uint32(payload.length), encoder.encode(type), payload, new Uint8Array(4));
}

function pngWith(...chunks) {
  return join(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', '\0'.repeat(13)),
    ...chunks,
    pngChunk('IEND'),
  );
}

function webpChunk(type, payloadText = '') {
  const payload = encoder.encode(payloadText);
  const padding = payload.length % 2 ? new Uint8Array([0]) : new Uint8Array();
  return join(encoder.encode(type), uint32(payload.length, true), payload, padding);
}

function webpWith(...chunks) {
  const body = join(encoder.encode('WEBP'), ...chunks);
  return join(encoder.encode('RIFF'), uint32(body.length, true), body);
}

test('detects common JPEG privacy metadata markers', () => {
  const fixtures = [
    [jpegSegment(0xe1, 'Exif\0\0GPS camera serial date'), 'exif'],
    [jpegSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>'), 'xmp'],
    [jpegSegment(0xed, 'Photoshop 3.0\0IPTC'), 'iptc'],
    [jpegSegment(0xfe, 'private comment'), 'comment'],
  ];

  for (const [segment, expectedKind] of fixtures) {
    const result = inspectImageMetadata(jpegWith(segment), 'image/jpeg', 'source.jpg');
    assert.equal(result.container, 'jpeg');
    assert.equal(result.fullyChecked, true);
    assert.equal(result.hasSensitiveMetadata, true);
    assert.deepEqual(result.findings.map((finding) => finding.kind), [expectedKind]);
  }
});

test('accepts a structural JPEG without sensitive application markers', () => {
  const result = inspectImageMetadata(jpegWith(jpegSegment(0xe0, 'JFIF\0')), 'image/jpeg');
  assert.equal(result.fullyChecked, true);
  assert.equal(result.hasSensitiveMetadata, false);
  assert.deepEqual(result.findings, []);
});

test('continues checking JPEG markers placed between image scans', () => {
  const bytes = join(
    new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0x00, 0x56]),
    jpegSegment(0xe1, 'Exif\0\0late metadata'),
    new Uint8Array([0xff, 0xd9]),
  );
  const result = inspectImageMetadata(bytes, 'image/jpeg');
  assert.equal(result.fullyChecked, true);
  assert.deepEqual(result.findings.map((finding) => finding.kind), ['exif']);
});

test('uses a fast header-only JPEG scan for source previews', () => {
  const bytes = join(
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe1, 'Exif\0\0source metadata'),
    new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0xd9]),
  );
  const result = inspectImageMetadata(bytes, 'image/jpeg', 'source.jpg', { strict: false });
  assert.equal(result.fullyChecked, false);
  assert.deepEqual(result.findings.map((finding) => finding.kind), ['exif']);
});

test('rejects sensitive or arbitrary bytes after JPEG EOI', () => {
  const trailing = join(jpegWith(), jpegSegment(0xe1, 'Exif\0\0trailer'));
  const result = inspectImageMetadata(trailing, 'image/jpeg');
  assert.equal(result.fullyChecked, false);
});

test('detects PNG EXIF, text, XMP, and embedded time chunks', () => {
  const result = inspectImageMetadata(
    pngWith(
      pngChunk('eXIf', 'camera and GPS tags'),
      pngChunk('tEXt', 'Author\0private'),
      pngChunk('iTXt', 'XML:com.adobe.xmp\0<xmpmeta>'),
      pngChunk('tIME', 'timestamp'),
    ),
    'image/png',
  );
  assert.equal(result.fullyChecked, true);
  assert.deepEqual(
    result.findings.map((finding) => finding.kind),
    ['exif', 'text', 'xmp', 'timestamp'],
  );
});

test('accepts a structural PNG containing no privacy text chunks', () => {
  const result = inspectImageMetadata(pngWith(pngChunk('IDAT', 'pixels')), 'image/png');
  assert.equal(result.fullyChecked, true);
  assert.equal(result.hasSensitiveMetadata, false);
});

test('rejects bytes after PNG IEND and non-empty IEND chunks', () => {
  const clean = pngWith(pngChunk('IDAT', 'pixels'));
  assert.equal(inspectImageMetadata(join(clean, pngChunk('tEXt', 'private')), 'image/png').fullyChecked, false);
  const nonEmptyIend = join(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', '\0'.repeat(13)),
    pngChunk('IEND', 'not empty'),
  );
  assert.equal(inspectImageMetadata(nonEmptyIend, 'image/png').fullyChecked, false);
});

test('detects WebP EXIF and XMP chunks', () => {
  const result = inspectImageMetadata(
    webpWith(webpChunk('VP8 ', 'pixels'), webpChunk('EXIF', 'GPS'), webpChunk('XMP ', 'private')),
    'image/webp',
  );
  assert.equal(result.fullyChecked, true);
  assert.deepEqual(result.findings.map((finding) => finding.kind), ['exif', 'xmp']);
});

test('rejects a WebP whose declared RIFF size does not cover the complete file', () => {
  const malformed = join(webpWith(webpChunk('VP8 ', 'pixels')), encoder.encode('trailing'));
  const result = inspectImageMetadata(malformed, 'image/webp');
  assert.equal(result.fullyChecked, false);
});

test('marks HEIC input as only partially inspected without raw payload scanning', () => {
  const heic = join(uint32(24), encoder.encode('ftyp'), encoder.encode('heic'), encoder.encode('Exif GPS payload'));
  const result = inspectImageMetadata(heic, 'image/heic', 'IMG_0001.HEIC');
  assert.equal(result.container, 'heic');
  assert.equal(result.fullyChecked, false);
  assert.equal(result.hasSensitiveMetadata, false);
  assert.deepEqual(result.findings, []);
});

test('rejects malformed output structure as not fully checked', () => {
  const truncatedPng = join(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    uint32(500),
    encoder.encode('tEXt'),
  );
  const result = inspectImageMetadata(truncatedPng, 'image/png');
  assert.equal(result.fullyChecked, false);
});

test('uses magic bytes before an untrusted filename or MIME type', () => {
  const cleanPng = pngWith(pngChunk('IDAT', 'pixels'));
  assert.equal(detectContainer(cleanPng, 'image/jpeg', 'misleading.jpg'), 'png');
  assert.equal(detectContainer(encoder.encode('<svg></svg>'), 'image/jpeg', 'misleading.jpg'), 'unknown');
});

test('formats byte sizes without exposing source details', () => {
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2.00 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12.0 MB');
});

test('reads JPEG and PNG dimensions before allocating decoded pixels', () => {
  const sofPayload = new Uint8Array([8, 0x17, 0x70, 0x1f, 0x40, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const sofLength = sofPayload.length + 2;
  const jpeg = jpegWith(new Uint8Array([0xff, 0xc0, sofLength >> 8, sofLength & 0xff, ...sofPayload]));
  assert.deepEqual(readImageDimensions(jpeg), { width: 8000, height: 6000 });

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, 4096, false);
  ihdrView.setUint32(4, 3072, false);
  const png = join(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    join(uint32(ihdr.length), encoder.encode('IHDR'), ihdr, new Uint8Array(4)),
    pngChunk('IEND'),
  );
  assert.deepEqual(readImageDimensions(png), { width: 4096, height: 3072 });
});
