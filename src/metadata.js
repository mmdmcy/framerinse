const JPEG_SIGNATURE = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const FINDING_LABELS = {
  app: 'unrecognized JPEG application metadata',
  comment: 'embedded comment',
  exif: 'EXIF (may include GPS, camera, or capture time)',
  iptc: 'APP13 / Photoshop metadata',
  text: 'text metadata',
  timestamp: 'embedded timestamp',
  xmp: 'XMP metadata',
};

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes, start, length) {
  let value = '';
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) value += String.fromCharCode(bytes[index]);
  return value;
}

function addFinding(findings, kind) {
  if (findings.some((finding) => finding.kind === kind)) return;
  findings.push({ kind, label: FINDING_LABELS[kind] });
}

function inspectJpeg(bytes, { strict = true } = {}) {
  const findings = [];
  let offset = 2;
  let structurallyComplete = false;
  let insideScan = false;

  while (offset < bytes.length) {
    if (insideScan) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.length) break;
    } else if (bytes[offset] !== 0xff) {
      break;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;

    if (insideScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    insideScan = false;

    if (marker === 0xd9) {
      structurallyComplete = offset === bytes.length;
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) break;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const payloadStart = offset + 2;
    const payloadLength = segmentLength - 2;
    const prefix = ascii(bytes, payloadStart, Math.min(payloadLength, 80));

    if (marker === 0xe1) {
      if (prefix.startsWith('Exif\0\0')) addFinding(findings, 'exif');
      else if (prefix.includes('xap/1.0') || prefix.includes('XMP')) addFinding(findings, 'xmp');
      else addFinding(findings, 'app');
    } else if (marker === 0xed) {
      addFinding(findings, 'iptc');
    } else if (marker === 0xfe) {
      addFinding(findings, 'comment');
    }

    offset += segmentLength;
    if (marker === 0xda) {
      if (!strict) break;
      insideScan = true;
    }
  }

  return { findings, structurallyComplete };
}

function inspectPng(bytes) {
  const findings = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let structurallyComplete = false;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const nextOffset = offset + 12 + length;
    if (nextOffset > bytes.length) break;

    if (type === 'eXIf') addFinding(findings, 'exif');
    if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const payload = ascii(bytes, offset + 8, Math.min(length, 160));
      if (/XML:com\.adobe\.xmp|xmp/i.test(payload)) addFinding(findings, 'xmp');
      else addFinding(findings, 'text');
    }
    if (type === 'tIME') addFinding(findings, 'timestamp');
    if (type === 'IEND') {
      structurallyComplete = length === 0 && nextOffset === bytes.length;
      break;
    }
    offset = nextOffset;
  }

  return { findings, structurallyComplete };
}

function inspectWebp(bytes) {
  const findings = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEnd = view.getUint32(4, true) + 8;
  const scanEnd = Math.min(bytes.length, declaredEnd);
  let offset = 12;
  let structurallyComplete = declaredEnd === bytes.length;

  while (offset + 8 <= scanEnd) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const paddedLength = length + (length % 2);
    const nextOffset = offset + 8 + paddedLength;
    if (nextOffset > scanEnd) {
      structurallyComplete = false;
      break;
    }
    if (type === 'EXIF') addFinding(findings, 'exif');
    if (type === 'XMP ') addFinding(findings, 'xmp');
    offset = nextOffset;
  }

  if (offset !== scanEnd) structurallyComplete = false;

  return { findings, structurallyComplete };
}

function inspectIsoMedia(bytes, container) {
  return {
    container,
    findings: [],
    fullyChecked: false,
    note: 'HEIC/AVIF metadata is not parsed on the main thread; the re-encoded output receives the strict check.',
  };
}

function detectContainer(bytes, _mimeType = '', _filename = '') {
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 3) === 'GIF') return 'gif';
  if (ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

function readImageDimensions(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const container = detectContainer(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (container === 'png' && bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR') {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (container === 'gif' && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (container === 'bmp' && bytes.length >= 26) {
    if (view.getUint32(14, true) === 12) {
      return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
    }
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }

  if (container === 'jpeg') {
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > bytes.length) break;
      if (sofMarkers.has(marker) && length >= 7) {
        return { width: view.getUint16(offset + 5, false), height: view.getUint16(offset + 3, false) };
      }
      offset += length;
    }
  }

  if (container === 'webp' && bytes.length >= 20) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const payload = offset + 8;
      if (payload + length > bytes.length) break;
      if (type === 'VP8X' && length >= 10) {
        const width = 1 + bytes[payload + 4] + (bytes[payload + 5] << 8) + (bytes[payload + 6] << 16);
        const height = 1 + bytes[payload + 7] + (bytes[payload + 8] << 8) + (bytes[payload + 9] << 16);
        return { width, height };
      }
      if (type === 'VP8L' && length >= 5 && bytes[payload] === 0x2f) {
        const width = 1 + bytes[payload + 1] + ((bytes[payload + 2] & 0x3f) << 8);
        const height = 1 + (bytes[payload + 2] >> 6) + (bytes[payload + 3] << 2) + ((bytes[payload + 4] & 0x0f) << 10);
        return { width, height };
      }
      if (
        type === 'VP8 ' &&
        length >= 10 &&
        bytes[payload + 3] === 0x9d &&
        bytes[payload + 4] === 0x01 &&
        bytes[payload + 5] === 0x2a
      ) {
        return {
          width: view.getUint16(payload + 6, true) & 0x3fff,
          height: view.getUint16(payload + 8, true) & 0x3fff,
        };
      }
      offset = payload + length + (length % 2);
    }
  }

  return null;
}

function inspectImageMetadata(arrayBuffer, mimeType = '', filename = '', options = {}) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const container = detectContainer(bytes, mimeType, filename);

  let result;
  if (container === 'jpeg') {
    const inspected = inspectJpeg(bytes, options);
    result = { container, findings: inspected.findings, fullyChecked: inspected.structurallyComplete };
  } else if (container === 'png') {
    const inspected = inspectPng(bytes);
    result = { container, findings: inspected.findings, fullyChecked: inspected.structurallyComplete };
  } else if (container === 'webp') {
    const inspected = inspectWebp(bytes);
    result = { container, findings: inspected.findings, fullyChecked: inspected.structurallyComplete };
  } else if (container === 'heic' || container === 'avif') {
    result = inspectIsoMedia(bytes, container);
  } else if (container === 'tiff') {
    result = {
      container,
      findings: [{ kind: 'exif', label: FINDING_LABELS.exif }],
      fullyChecked: false,
      note: 'TIFF commonly contains tag-based metadata; the output will use a new container.',
    };
  } else if (container === 'gif') {
    result = {
      container,
      findings: [],
      fullyChecked: false,
      note: 'Animated input is frozen to one still frame before review and export.',
    };
  } else if (container === 'bmp') {
    result = {
      container,
      findings: [],
      fullyChecked: false,
      note: 'BMP metadata is not fully parsed; the output will use a new container.',
    };
  } else {
    result = {
      container,
      findings: [],
      fullyChecked: false,
      note: 'The input container is not recognized, but decoded pixels can still be re-encoded.',
    };
  }

  return {
    ...result,
    hasSensitiveMetadata: result.findings.length > 0,
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export { detectContainer, formatBytes, inspectImageMetadata, readImageDimensions };
