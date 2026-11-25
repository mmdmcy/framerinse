// Strict, allow-list check of a finished export. It does not trust the encoder:
// it walks the whole container and accepts only the structures an image needs
// to be shown. Anything else (EXIF, XMP, IPTC, ICC, comments, text, timestamps,
// thumbnails, unknown chunks, trailing bytes) makes the file fail.

import { crc32 } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG chunks that carry only how to draw the pixels.
const PNG_ALLOWED = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'pHYs', 'sBIT', 'bKGD']);
const PNG_KINDS = { eXIf: 'exif', iCCP: 'icc', tEXt: 'text', zTXt: 'text', iTXt: 'text', tIME: 'timestamp' };

// JPEG markers that carry only the coded image: frame headers, tables, restart interval.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdd]);

// WebP VP8X flags that announce metadata or animation.
const VP8X_ICC = 0x20;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

function ascii(bytes, start, length) {
  return Buffer.from(bytes.subarray(start, Math.min(bytes.length, start + length))).toString('latin1');
}

function result(container, problems, width = 0, height = 0) {
  return { container, height, ok: problems.length === 0, problems: [...new Set(problems)], width };
}

function jpegAppKind(marker, payload) {
  if (marker === 0xed) return 'iptc';
  if (payload.startsWith('Exif\0')) return 'exif';
  if (payload.includes('xap/1.0') || payload.includes('XMP')) return 'xmp';
  if (payload.startsWith('ICC_PROFILE')) return 'icc';
  return 'app';
}

// decoy: the exact APP1 segment (marker included) the decoy writer made. It
// must sit right after SOI, byte for byte; every other APPn is still refused,
// a second EXIF segment too.
function verifyJpeg(bytes, decoy) {
  const problems = [];
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  let sawJfif = false;
  let offset = 2;
  if (decoy) {
    if (!bytes.subarray(2, 2 + decoy.length).equals(decoy)) return result('jpeg', ['not the expected decoy EXIF']);
    offset += decoy.length;
  }

  for (;;) {
    if (offset >= bytes.length) return result('jpeg', ['truncated'], width, height);
    if (bytes[offset] !== 0xff) return result('jpeg', ['bytes outside a segment'], width, height);
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return result('jpeg', ['truncated'], width, height);
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9) {
      if (offset !== bytes.length) problems.push('bytes after the end of the image');
      if (!sawFrame || !sawScan) problems.push('no image data');
      return result('jpeg', problems, width, height);
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      return result('jpeg', [`unexpected marker 0x${marker.toString(16)}`], width, height);
    }
    if (offset + 2 > bytes.length) return result('jpeg', ['truncated'], width, height);
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return result('jpeg', ['truncated segment'], width, height);
    const payloadStart = offset + 2;
    const payloadLength = length - 2;

    if (marker === 0xe0) {
      // One plain JFIF header, 14 bytes, with no embedded thumbnail.
      const isJfif = payloadLength === 14 && ascii(bytes, payloadStart, 5) === 'JFIF\0';
      if (!isJfif || sawJfif || bytes[payloadStart + 12] !== 0 || bytes[payloadStart + 13] !== 0) {
        problems.push('app');
      }
      sawJfif = true;
    } else if (marker >= 0xe1 && marker <= 0xef) {
      problems.push(jpegAppKind(marker, ascii(bytes, payloadStart, Math.min(payloadLength, 80))));
    } else if (marker === 0xfe) {
      problems.push('comment');
    } else if (JPEG_SOF.has(marker)) {
      if (sawFrame || payloadLength < 6) return result('jpeg', ['bad frame header'], width, height);
      sawFrame = true;
      height = (bytes[payloadStart + 1] << 8) | bytes[payloadStart + 2];
      width = (bytes[payloadStart + 3] << 8) | bytes[payloadStart + 4];
    } else if (marker === 0xda) {
      if (!sawFrame) return result('jpeg', ['scan before frame header'], width, height);
      sawScan = true;
      offset += length;
      // Entropy-coded data: skip stuffed 0xFF00 bytes and restart markers.
      for (;;) {
        while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
        if (offset + 1 >= bytes.length) return result('jpeg', ['truncated scan'], width, height);
        const next = bytes[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
        } else if (next === 0xff) {
          offset += 1;
        } else {
          break;
        }
      }
      continue;
    } else if (!JPEG_TABLES.has(marker)) {
      problems.push(`unknown marker 0x${marker.toString(16)}`);
    }
    offset += length;
  }
}

function verifyPng(bytes) {
  const problems = [];
  let width = 0;
  let height = 0;
  let offset = PNG_SIGNATURE.length;
  let first = true;
  let sawData = false;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return result('png', ['truncated chunk'], width, height);
    if (bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) {
      return result('png', [`bad checksum in ${JSON.stringify(type)}`], width, height);
    }
    if (first) {
      if (type !== 'IHDR' || length !== 13) return result('png', ['missing header'], width, height);
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      first = false;
    } else if (type === 'IHDR') {
      problems.push('second header');
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) problems.push('bytes after the end of the image');
      if (!sawData) problems.push('no image data');
      return result('png', problems, width, height);
    }
    if (!PNG_ALLOWED.has(type)) problems.push(PNG_KINDS[type] || `unknown chunk ${JSON.stringify(type)}`);
    offset = end;
  }
  return result('png', ['truncated'], width, height);
}

function verifyWebp(bytes) {
  const problems = [];
  if (bytes.length < 20) return result('webp', ['truncated']);
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return result('webp', ['RIFF size does not match the file']);
  let width = 0;
  let height = 0;
  let offset = 12;
  let index = 0;
  let extended = false;
  let imageChunks = 0;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return result('webp', ['truncated chunk'], width, height);
    const type = ascii(bytes, offset, 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const end = payload + length + (length % 2);
    if (end > bytes.length) return result('webp', ['truncated chunk'], width, height);

    if (type === 'VP8X') {
      if (index !== 0 || length < 10) {
        problems.push('misplaced extended header');
      } else {
        extended = true;
        const flags = bytes[payload];
        if (flags & VP8X_ICC) problems.push('icc');
        if (flags & VP8X_EXIF) problems.push('exif');
        if (flags & VP8X_XMP) problems.push('xmp');
        if (flags & VP8X_ANIMATION) problems.push('animation');
        width = 1 + bytes.readUIntLE(payload + 4, 3);
        height = 1 + bytes.readUIntLE(payload + 7, 3);
      }
    } else if (type === 'VP8 ' || type === 'VP8L') {
      imageChunks += 1;
      if (!extended) {
        if (type === 'VP8L' && length >= 5 && bytes[payload] === 0x2f) {
          const bits = bytes.readUInt32LE(payload + 1);
          width = (bits & 0x3fff) + 1;
          height = ((bits >> 14) & 0x3fff) + 1;
        } else if (type === 'VP8 ' && length >= 10 && bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a) {
          width = bytes.readUInt16LE(payload + 6) & 0x3fff;
          height = bytes.readUInt16LE(payload + 8) & 0x3fff;
        }
      }
    } else if (type === 'ALPH') {
      if (!extended) problems.push('alpha without extended header');
    } else if (type === 'ICCP') {
      problems.push('icc');
    } else if (type === 'EXIF') {
      problems.push('exif');
    } else if (type === 'XMP ') {
      problems.push('xmp');
    } else if (type === 'ANIM' || type === 'ANMF') {
      problems.push('animation');
    } else {
      problems.push(`unknown chunk ${JSON.stringify(type)}`);
    }
    offset = end;
    index += 1;
  }
  if (imageChunks !== 1) problems.push('not exactly one image');
  return result('webp', problems, width, height);
}

// Returns { container, ok, problems, width, height }. ok is true only for a
// complete JPEG, PNG, or WebP made of allowed structures alone. With
// { decoy: segment }, a JPEG must also start with exactly that APP1 segment
// (src/decoy.js), and any other file fails.
function verifyCleanImage(input, { decoy } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return verifyJpeg(bytes, decoy);
  if (decoy) return result('unknown', ['the decoy EXIF is for JPEG only']);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return verifyPng(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return verifyWebp(bytes);
  return result('unknown', ['not a JPEG, PNG, or WebP']);
}

export { verifyCleanImage };
