// The cleaning pipeline the server and the command line share: read a source
// photo's header, render a clean export, and check the result byte by byte.
// Every step works on files in a private folder the caller owns.

import { open, readFile, writeFile } from 'node:fs/promises';

import { decoyDay, decoySegment, findDecoy, insertDecoy } from './decoy.js';

import { detectContainer, inspectImageMetadata } from './metadata.js';
import { verifyCleanImage } from './verify.js';
import { LOADERS, readSourceHeader, renderImage, SOURCE_FORMATS } from './vips.js';

const MAX_INPUT_PIXELS = 100_000_000;
const MAX_EDGES = [1080, 2048, 4096];
const OUTPUT_FORMATS = {
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  png: { extension: 'png', mime: 'image/png' },
  webp: { extension: 'webp', mime: 'image/webp' },
};

// Input the pipeline refuses; status is the HTTP answer the server gives.
class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readPrefix(filePath, maximumBytes = 4 * 1024 * 1024) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maximumBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function unreadableMessage(format) {
  return format === 'heic' ? 'The server could not decode that HEIC photo.' : 'The server could not decode that photo format.';
}

function outputDimensions(sourceWidth, sourceHeight, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

// Covers are normalized to the upright photo (0 to 1 on each axis).
function validateScrubSettings(value) {
  const format = typeof value?.format === 'string' ? value.format : 'jpeg';
  if (!OUTPUT_FORMATS[format]) throw new InputError(400, 'Output format must be JPEG, PNG, or WebP.');
  const maxEdge = Number(value?.maxEdge ?? 2048);
  if (!MAX_EDGES.includes(maxEdge)) throw new InputError(400, 'Output size is not supported.');
  const quality = Number(value?.quality ?? 90);
  if (!Number.isInteger(quality) || quality < 65 || quality > 100) {
    throw new InputError(400, 'Quality must be from 65 to 100.');
  }
  if (!Array.isArray(value?.covers) || value.covers.length > 50) {
    throw new InputError(400, 'Covers must be an array containing at most 50 rectangles.');
  }

  const covers = value.covers.map((cover) => {
    const normalized = {
      x: Number(cover?.x),
      y: Number(cover?.y),
      width: Number(cover?.width),
      height: Number(cover?.height),
    };
    if (
      Object.values(normalized).some((item) => !Number.isFinite(item)) ||
      normalized.x < 0 ||
      normalized.y < 0 ||
      normalized.width <= 0 ||
      normalized.height <= 0 ||
      normalized.x + normalized.width > 1.001 ||
      normalized.y + normalized.height > 1.001
    ) {
      throw new InputError(400, 'A cover rectangle is outside the photo.');
    }
    return normalized;
  });
  // The decoy EXIF is optional and off unless asked for with true.
  const decoy = value?.decoy ?? false;
  if (typeof decoy !== 'boolean') throw new InputError(400, 'Decoy must be true or false.');
  if (decoy && format !== 'jpeg') throw new InputError(400, 'The decoy EXIF is written to JPEG only; choose JPEG or leave the decoy off.');
  return { covers, decoy, format, maxEdge, quality };
}

// Reads what the pipeline needs from the source's first bytes and its header,
// without decoding a pixel: the format (from magic bytes, matched against the
// loader libvips picks), the upright size, and whether metadata was seen.
async function readSource(sourcePath, workDir) {
  const prefix = await readPrefix(sourcePath);
  const inputInspection = inspectImageMetadata(prefix, '', 'source', { strict: false });
  const container = detectContainer(prefix);
  const format = SOURCE_FORMATS[container];
  if (!format) {
    if (/^\s*(<\?xml|<svg|%PDF)/i.test(prefix.subarray(0, 256).toString('latin1'))) {
      throw new InputError(415, 'Choose a raster photo such as JPEG, PNG, WebP, HEIC, AVIF, GIF, or TIFF.');
    }
    throw new InputError(415, 'The server could not decode that photo format.');
  }
  const isHeic = container === 'heic';
  const unreadable = unreadableMessage(format);
  const header = await readSourceHeader(sourcePath, workDir);
  if (header.loader !== LOADERS[format] || !Number.isInteger(header.width) || !Number.isInteger(header.height) || header.width < 1 || header.height < 1) {
    throw new InputError(415, unreadable);
  }
  // HEIC rotation is applied by the decoder itself; EXIF orientation counts for the rest.
  const autorotate = !LOADERS[format].startsWith('heif');
  const swapped = autorotate && header.orientation >= 5 && header.orientation <= 8;
  const oriented = swapped ? { width: header.height, height: header.width } : { width: header.width, height: header.height };
  // Refused from the header alone, before any pixel is decoded. The answers
  // are the ones the server gave before: 413 for HEIC, and for the rest the
  // "could not decode" 415 that the old image library's pixel limit raised.
  if (oriented.width * oriented.height > MAX_INPUT_PIXELS) {
    if (isHeic) throw new InputError(413, 'Photo is over the 100 megapixel processing limit.');
    throw new InputError(415, unreadable);
  }
  const metadataDetected = header.metadataPresent || inputInspection.hasSensitiveMetadata;
  return {
    autorotate,
    format,
    height: oriented.height,
    loader: LOADERS[format],
    metadataDetected,
    metadataStatus: metadataDetected ? 'detected' : isHeic ? 'not-fully-checked' : 'not-detected',
    width: oriented.width,
  };
}

// Renders the clean export of a source read by readSource() to `output`, then
// runs two independent checks on its bytes: the marker scan, and a strict
// allow-list walk of the whole container that refuses anything not needed to
// draw the pixels. Throws when either fails; the caller then removes `output`.
// With settings.decoy, the decoy EXIF (src/decoy.js, dated `now`) goes in
// after SOI, and the checks accept exactly that segment and nothing more.
async function cleanImage({ now = new Date(), output, settings, source, sourceFormat, sourceHeight, sourceWidth }) {
  const dimensions = outputDimensions(sourceWidth, sourceHeight, settings.maxEdge);
  const outputFormat = OUTPUT_FORMATS[settings.format];
  await renderImage({
    autorotate: !LOADERS[sourceFormat].startsWith('heif'),
    covers: settings.covers,
    flatten: settings.format === 'jpeg',
    height: dimensions.height,
    loader: LOADERS[sourceFormat],
    output,
    save: { format: settings.format, progressive: true, quality: settings.quality },
    source,
    sourceHeight,
    sourceWidth,
    width: dimensions.width,
  });

  let bytes = await readFile(output);
  const decoy = settings.decoy ? decoySegment(decoyDay(now)) : undefined;
  if (decoy) {
    bytes = insertDecoy(bytes, decoy);
    await writeFile(output, bytes);
  }
  const inspection = inspectImageMetadata(bytes, outputFormat.mime, `framerinse.${outputFormat.extension}`);
  const verified = verifyCleanImage(bytes, { decoy });
  const expectedFindings = decoy ? 'exif' : '';
  if (
    !inspection.fullyChecked ||
    inspection.findings.map((finding) => finding.kind).join() !== expectedFindings ||
    !verified.ok ||
    verified.container !== settings.format ||
    verified.width !== dimensions.width ||
    verified.height !== dimensions.height
  ) {
    throw new Error(`Generated output did not pass the metadata check (${verified.problems.join(', ') || 'size or container mismatch'}).`);
  }
  return { bytes: bytes.length, decoy: decoy ? findDecoy(bytes).fields : null, height: dimensions.height, width: dimensions.width };
}

const KIND_LABELS = {
  animation: 'animation frames',
  app: 'other application data (APPn segment)',
  comment: 'embedded comment',
  exif: 'EXIF (may include GPS, camera, or capture time)',
  gps: 'GPS position',
  icc: 'ICC colour profile',
  iptc: 'IPTC / Photoshop metadata',
  makernote: "camera maker notes",
  text: 'text metadata',
  timestamp: 'embedded timestamp',
  xmp: 'XMP metadata',
};

// What a file carries beyond its pixels, read by every checker the pipeline
// has: the marker scan and the strict walk (JPEG, PNG, WebP; the same walk an
// export must pass) and the libvips header (every format it reads, HEIC too).
// Returns { container, width, height, fullyChecked, found: [{ kind, label }] };
// found is empty only for a file the strict walk accepts.
async function inspectFile(filePath, workDir) {
  const prefix = await readPrefix(filePath, 64);
  const container = detectContainer(prefix);
  const header = await readSourceHeader(filePath, workDir);
  const kinds = [...header.metadataKinds];
  let fullyChecked = false;
  let width = header.width;
  let height = header.height;
  let decoy = null;
  if (OUTPUT_FORMATS[container]) {
    const bytes = await readFile(filePath);
    const verified = verifyCleanImage(bytes);
    kinds.push(...inspectImageMetadata(bytes).findings.map((finding) => finding.kind), ...verified.problems);
    fullyChecked = true;
    width ||= verified.width;
    height ||= verified.height;
    // A file that is clean but for the exact segment `clean --decoy` writes.
    const written = findDecoy(bytes);
    if (written && verifyCleanImage(bytes, { decoy: written.segment }).ok) decoy = written.fields;
  } else if (!header.loader) {
    throw new InputError(415, 'Not an image libvips can read.');
  }
  const found = [...new Set(kinds)].map((kind) => ({ kind, label: KIND_LABELS[kind] || kind }));
  // The decoy is still EXIF and is reported as such, with its fields named.
  const exif = found.find((item) => item.kind === 'exif');
  if (decoy && exif) {
    exif.label = 'EXIF: only the decoy fields that clean --decoy writes';
    exif.fields = decoy;
  }
  return { container, found, fullyChecked, height: height || 0, width: width || 0 };
}

export { cleanImage, InputError, inspectFile, MAX_EDGES, OUTPUT_FORMATS, outputDimensions, readSource, unreadableMessage, validateScrubSettings };
