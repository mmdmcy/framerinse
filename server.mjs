import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import decodeHeic from 'heic-decode';
import sharp from 'sharp';

import { detectContainer, inspectImageMetadata } from './src/metadata.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_JSON_BYTES = 64 * 1024;
const PREVIEW_EDGE = 1400;
const OUTPUT_FORMATS = {
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  png: { extension: 'png', mime: 'image/png' },
  webp: { extension: 'webp', mime: 'image/webp' },
};
const INPUT_FORMATS = new Set(['avif', 'gif', 'heic', 'heif', 'jpeg', 'png', 'tiff', 'webp']);

const publicFiles = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['icons/icon.svg', 'image/svg+xml'],
  ['src/app.js', 'text/javascript; charset=utf-8'],
]);

const documentCsp = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseOptions(argv = process.argv.slice(2), env = process.env) {
  let host = env.FRAMERINSE_HOST || '0.0.0.0';
  let port = parseInteger(env.FRAMERINSE_PORT, 4173, 1, 65535, 'Port');
  let dataDir = env.FRAMERINSE_DATA_DIR || path.join(tmpdir(), 'framerinse');
  const ttlMinutes = parseInteger(env.FRAMERINSE_JOB_TTL_MINUTES, 60, 5, 1440, 'Job TTL');

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host') {
      host = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--port') {
      port = parseInteger(argv[index + 1], 4173, 1, 65535, 'Port');
      index += 1;
    } else if (argument === '--data-dir') {
      dataDir = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!host) throw new Error('Host cannot be empty.');
  if (!dataDir) throw new Error('Data directory cannot be empty.');
  return { dataDir: path.resolve(dataDir), help: false, host, port, ttlMinutes };
}

function securityHeaders(fileName = '') {
  const headers = {
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), browsing-topics=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  if (fileName === 'index.html') headers['Content-Security-Policy'] = documentCsp;
  return headers;
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Length': data.length,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(data);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'Request settings are too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request settings are not valid JSON.');
  }
}

async function streamUpload(request, destination) {
  const declaredSize = Number(request.headers['content-length'] || 0);
  if (declaredSize > MAX_UPLOAD_BYTES) {
    request.resume();
    throw new HttpError(413, 'Photo is over the 100 MB upload limit.');
  }

  const output = createWriteStream(destination, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        request.resume();
        throw new HttpError(413, 'Photo is over the 100 MB upload limit.');
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (size === 0) throw new HttpError(400, 'No photo bytes were received.');
  return size;
}

function metadataWasPresent(metadata) {
  return Boolean(
    metadata.exif ||
      metadata.xmp ||
      metadata.iptc ||
      metadata.orientation ||
      (Array.isArray(metadata.comments) && metadata.comments.length),
  );
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

async function decodeHeicSource(sourceFile, decodedFile) {
  const source = await readFile(sourceFile);
  let images;
  try {
    images = await decodeHeic.all({ buffer: source });
    const image = images[0];
    const width = Number(image?.width);
    const height = Number(image?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new HttpError(415, 'The server could not read that HEIC photo.');
    }
    if (width * height > MAX_INPUT_PIXELS) {
      throw new HttpError(413, 'Photo is over the 100 megapixel processing limit.');
    }

    const decoded = await image.decode();
    const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    await sharp(pixels, { raw: { channels: 4, height, width } })
      .png({ compressionLevel: 1 })
      .toFile(decodedFile);
    return { format: 'heic', height, width };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(415, 'The server could not decode that HEIC photo.');
  } finally {
    images?.dispose?.();
  }
}

function validateScrubSettings(value) {
  const format = typeof value?.format === 'string' ? value.format : 'jpeg';
  if (!OUTPUT_FORMATS[format]) throw new HttpError(400, 'Output format must be JPEG, PNG, or WebP.');
  const maxEdge = Number(value?.maxEdge ?? 2048);
  if (![1080, 2048, 4096].includes(maxEdge)) throw new HttpError(400, 'Output size is not supported.');
  const quality = Number(value?.quality ?? 90);
  if (!Number.isInteger(quality) || quality < 65 || quality > 100) {
    throw new HttpError(400, 'Quality must be from 65 to 100.');
  }
  if (!Array.isArray(value?.covers) || value.covers.length > 50) {
    throw new HttpError(400, 'Covers must be an array containing at most 50 rectangles.');
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
      throw new HttpError(400, 'A cover rectangle is outside the photo.');
    }
    return normalized;
  });
  return { covers, format, maxEdge, quality };
}

function outputDimensions(sourceWidth, sourceHeight, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function coverSvg(covers, width, height) {
  const rectangles = covers
    .map((cover) => {
      const x = Math.max(0, Math.floor(cover.x * width) - 1);
      const y = Math.max(0, Math.floor(cover.y * height) - 1);
      const right = Math.min(width, Math.ceil((cover.x + cover.width) * width) + 1);
      const bottom = Math.min(height, Math.ceil((cover.y + cover.height) * height) + 1);
      return `<rect x="${x}" y="${y}" width="${right - x}" height="${bottom - y}" fill="#050706"/>`;
    })
    .join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangles}</svg>`);
}

async function serveFile(request, response, filePath, contentType, disposition = '', securityName = '') {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new HttpError(404, 'File not found.');
  }
  const headers = {
    ...securityHeaders(securityName),
    'Content-Length': fileStats.size,
    'Content-Type': contentType,
  };
  if (disposition) headers['Content-Disposition'] = disposition;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function createFrameRinseServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(tmpdir(), 'framerinse'));
  const jobsDir = path.join(dataDir, 'jobs');
  const ttlMinutes = options.ttlMinutes || 60;
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(path.join(dataDir, 'framerinse.sqlite'), { timeout: 5000 });
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      source_format TEXT NOT NULL,
      source_width INTEGER NOT NULL,
      source_height INTEGER NOT NULL,
      source_bytes INTEGER NOT NULL,
      metadata_detected INTEGER NOT NULL,
      output_format TEXT,
      output_width INTEGER,
      output_height INTEGER,
      output_bytes INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jobs_expires_at ON jobs(expires_at);
  `);

  const getJobStatement = database.prepare('SELECT * FROM jobs WHERE id = ?');
  const insertJobStatement = database.prepare(`
    INSERT INTO jobs (
      id, created_at, expires_at, source_format, source_width, source_height,
      source_bytes, metadata_detected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateOutputStatement = database.prepare(`
    UPDATE jobs SET output_format = ?, output_width = ?, output_height = ?, output_bytes = ? WHERE id = ?
  `);
  const deleteJobStatement = database.prepare('DELETE FROM jobs WHERE id = ?');
  const expiredJobsStatement = database.prepare('SELECT id FROM jobs WHERE expires_at <= ?');
  const allJobIdsStatement = database.prepare('SELECT id FROM jobs');

  const jobDirectory = (id) => path.join(jobsDir, id);
  const sourcePath = (id) => path.join(jobDirectory(id), 'source');
  const decodedPath = (id) => path.join(jobDirectory(id), 'decoded.png');
  const previewPath = (id) => path.join(jobDirectory(id), 'preview.jpg');
  const outputPath = (id, format) => path.join(jobDirectory(id), `output.${OUTPUT_FORMATS[format].extension}`);

  async function processingPath(id) {
    try {
      await stat(decodedPath(id));
      return decodedPath(id);
    } catch {
      return sourcePath(id);
    }
  }

  async function removeJob(id) {
    deleteJobStatement.run(id);
    await rm(jobDirectory(id), { force: true, recursive: true });
  }

  async function cleanupExpired() {
    const expired = expiredJobsStatement.all(Date.now());
    await Promise.all(expired.map((job) => removeJob(job.id)));
  }

  async function cleanupOrphans() {
    const known = new Set(allJobIdsStatement.all().map((job) => job.id));
    const entries = await readdir(jobsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !known.has(entry.name))
        .map((entry) => rm(path.join(jobsDir, entry.name), { force: true, recursive: true })),
    );
  }

  async function liveJob(id) {
    const job = getJobStatement.get(id);
    if (!job) return null;
    if (job.expires_at <= Date.now()) {
      await removeJob(id);
      return null;
    }
    return job;
  }

  await cleanupExpired();
  await cleanupOrphans();
  const cleanupTimer = setInterval(() => cleanupExpired().catch(() => {}), 10 * 60 * 1000);
  cleanupTimer.unref();

  async function uploadPhoto(request, response) {
    const id = randomUUID();
    const directory = jobDirectory(id);
    await mkdir(directory, { mode: 0o700 });
    try {
      const sourceBytes = await streamUpload(request, sourcePath(id));
      const prefix = await readPrefix(sourcePath(id));
      const inputInspection = inspectImageMetadata(prefix, '', 'source', { strict: false });
      let metadata;
      let metadataFullyInspected = true;
      let processFile = sourcePath(id);
      if (detectContainer(prefix) === 'heic') {
        metadata = await decodeHeicSource(sourcePath(id), decodedPath(id));
        metadataFullyInspected = false;
        processFile = decodedPath(id);
      } else {
        try {
          metadata = await sharp(sourcePath(id), { animated: false, limitInputPixels: MAX_INPUT_PIXELS }).metadata();
        } catch {
          throw new HttpError(415, 'The server could not decode that photo format.');
        }
      }
      if (!INPUT_FORMATS.has(metadata.format)) {
        throw new HttpError(415, 'Choose a raster photo such as JPEG, PNG, WebP, HEIC, AVIF, GIF, or TIFF.');
      }
      const oriented = metadata.autoOrient || { width: metadata.width, height: metadata.height };
      if (!oriented.width || !oriented.height || oriented.width * oriented.height > MAX_INPUT_PIXELS) {
        throw new HttpError(413, 'Photo is over the 100 megapixel processing limit.');
      }
      const metadataDetected = metadataWasPresent(metadata) || inputInspection.hasSensitiveMetadata;

      await sharp(processFile, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
        .autoOrient()
        .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82 })
        .toFile(previewPath(id));

      const now = Date.now();
      const expiresAt = now + ttlMinutes * 60 * 1000;
      insertJobStatement.run(
        id,
        now,
        expiresAt,
        metadata.format,
        oriented.width,
        oriented.height,
        sourceBytes,
        metadataDetected ? 1 : 0,
      );
      sendJson(response, 201, {
        id,
        expiresAt,
        previewUrl: `/api/jobs/${id}/preview`,
        source: {
          bytes: sourceBytes,
          format: metadata.format,
          height: oriented.height,
          metadataDetected,
          metadataStatus: metadataDetected ? 'detected' : metadataFullyInspected ? 'not-detected' : 'not-fully-checked',
          width: oriented.width,
        },
      });
    } catch (error) {
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  async function scrubPhoto(id, request, response) {
    const job = await liveJob(id);
    if (!job) throw new HttpError(404, 'Photo job expired or was cleared.');
    const settings = validateScrubSettings(await readJson(request));
    const dimensions = outputDimensions(job.source_width, job.source_height, settings.maxEdge);
    const output = OUTPUT_FORMATS[settings.format];
    const temporaryPath = path.join(jobDirectory(id), `output-${randomUUID()}.tmp`);
    const finalPath = outputPath(id, settings.format);
    const processFile = await processingPath(id);

    try {
      let pipeline = sharp(processFile, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
        .autoOrient()
        .resize({ width: settings.maxEdge, height: settings.maxEdge, fit: 'inside', withoutEnlargement: true });
      if (settings.covers.length) {
        pipeline = pipeline.composite([{ input: coverSvg(settings.covers, dimensions.width, dimensions.height) }]);
      }
      if (settings.format === 'jpeg') {
        pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: settings.quality, mozjpeg: true });
      } else if (settings.format === 'png') {
        pipeline = pipeline.png({ compressionLevel: 9 });
      } else {
        pipeline = pipeline.webp({ quality: settings.quality });
      }
      await pipeline.toFile(temporaryPath);

      const outputBytes = await readFile(temporaryPath);
      const inspection = inspectImageMetadata(outputBytes, output.mime, `framerinse.${output.extension}`);
      if (!inspection.fullyChecked || inspection.hasSensitiveMetadata) {
        throw new Error('Generated output did not pass the metadata check.');
      }

      for (const entry of await readdir(jobDirectory(id))) {
        if (entry.startsWith('output.') && path.join(jobDirectory(id), entry) !== finalPath) {
          await unlink(path.join(jobDirectory(id), entry)).catch(() => {});
        }
      }
      await rename(temporaryPath, finalPath);
      updateOutputStatement.run(settings.format, dimensions.width, dimensions.height, outputBytes.length, id);
      sendJson(response, 200, {
        coverCount: settings.covers.length,
        downloadUrl: `/api/jobs/${id}/output?download=1`,
        expiresAt: job.expires_at,
        format: settings.format,
        height: dimensions.height,
        outputUrl: `/api/jobs/${id}/output`,
        size: outputBytes.length,
        width: dimensions.width,
      });
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function handleRequest(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        await uploadPhoto(request, response);
        return;
      }

      const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(preview|output|scrub))?$/);
      if (match) {
        const [, id, action] = match;
        if (!action && request.method === 'DELETE') {
          const job = await liveJob(id);
          if (job) await removeJob(id);
          response.writeHead(204, securityHeaders());
          response.end();
          return;
        }
        if (action === 'scrub' && request.method === 'POST') {
          await scrubPhoto(id, request, response);
          return;
        }
        if ((action === 'preview' || action === 'output') && (request.method === 'GET' || request.method === 'HEAD')) {
          const job = await liveJob(id);
          if (!job) throw new HttpError(404, 'Photo job expired or was cleared.');
          if (action === 'preview') {
            await serveFile(request, response, previewPath(id), 'image/jpeg', 'inline; filename="framerinse-preview.jpg"');
            return;
          }
          if (!job.output_format) throw new HttpError(404, 'Cleaned photo is not ready.');
          const output = OUTPUT_FORMATS[job.output_format];
          const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
          await serveFile(
            request,
            response,
            outputPath(id, job.output_format),
            output.mime,
            `${disposition}; filename="framerinse.${output.extension}"`,
          );
          return;
        }
        throw new HttpError(405, 'Method not allowed.');
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'Bad request.');
      }
      const fileName = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const contentType = publicFiles.get(fileName);
      if (!contentType) throw new HttpError(404, 'Not found.');
      await serveFile(request, response, path.join(root, fileName), contentType, '', fileName);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'The server could not process the photo.';
      if (!(error instanceof HttpError)) {
        process.stderr.write(`FrameRinse request failed: ${error?.stack || error}\n`);
      }
      sendJson(response, status, { error: message });
    }
  }

  const server = createServer(handleRequest);
  return {
    cleanupExpired,
    close() {
      clearInterval(cleanupTimer);
      database.close();
    },
    dataDir,
    handleRequest,
    server,
  };
}

function printHelp() {
  process.stdout.write(`FrameRinse self-hosted server\n\nUsage: node server.mjs [--host HOST] [--port PORT] [--data-dir PATH]\n\nEnvironment:\n  FRAMERINSE_HOST              Bind address (default 0.0.0.0)\n  FRAMERINSE_PORT              Port (default 4173)\n  FRAMERINSE_DATA_DIR          Temporary job/database directory\n  FRAMERINSE_JOB_TTL_MINUTES   Auto-delete delay (default 60)\n`);
}

async function main() {
  const options = parseOptions();
  if (options.help) {
    printHelp();
    return;
  }
  const app = await createFrameRinseServer(options);
  app.server.on('error', (error) => {
    process.stderr.write(`FrameRinse server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  app.server.listen(options.port, options.host, () => {
    process.stdout.write(`FrameRinse is available over HTTP on ${options.host}:${options.port}\n`);
    process.stdout.write(`Temporary jobs are stored in ${app.dataDir}\n`);
  });

  const shutdown = () => {
    app.server.close(() => {
      app.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { createFrameRinseServer, parseOptions, publicFiles, securityHeaders };
