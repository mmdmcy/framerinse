import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { cleanImage, InputError, OUTPUT_FORMATS, outputDimensions, readSource, unreadableMessage, validateScrubSettings } from './src/pipeline.js';
import { verifyCleanImage } from './src/verify.js';
import { checkVips, renderImage, VipsError } from './src/vips.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const PREVIEW_EDGE = 1400;

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

// The pipeline's refusals (InputError) carry their HTTP status too.
class HttpError extends InputError {}

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
  let dataDir = env.FRAMERINSE_DATA_DIR || defaultDataDir(env);
  const ttlMinutes = parseInteger(env.FRAMERINSE_JOB_TTL_MINUTES, 60, 5, 1440, 'Job TTL');
  let maxTotalBytes = parseInteger(env.FRAMERINSE_MAX_TOTAL_MB, 0, 1, 1_000_000, 'Total storage limit') * 1024 * 1024 || DEFAULT_MAX_TOTAL_BYTES;

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
    } else if (argument === '--max-total-mb') {
      maxTotalBytes = parseInteger(argv[index + 1], 0, 1, 1_000_000, 'Total storage limit') * 1024 * 1024;
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!host) throw new Error('Host cannot be empty.');
  if (!dataDir) throw new Error('Data directory cannot be empty.');
  return { dataDir: path.resolve(dataDir), help: false, host, maxTotalBytes, port, ttlMinutes };
}

// Per-user state directory, not the shared /tmp: nobody else can pre-create it.
function defaultDataDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'framerinse');
}

// Create the directory with mode 0700, or accept an existing one only when the
// current user owns it, tightening its mode. Refuses someone else's directory.
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stats = await stat(directory);
  if (!stats.isDirectory()) throw new Error(`${directory} is not a directory.`);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${directory} is owned by another user (uid ${stats.uid}); refusing to use it.`);
  }
  if ((stats.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
}

// Browsers send Sec-Fetch-Site and Origin; a drive-by page on another site is
// refused before any bytes are stored. Non-browser clients send neither.
function rejectCrossSite(request) {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
  const origin = request.headers.origin;
  if (origin && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Cross-site requests are not allowed.');
    }
    if (originHost !== request.headers.host) throw new HttpError(403, 'Cross-site requests are not allowed.');
  } else if (origin === 'null') {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
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

async function streamUpload(request, destination, remainingBytes, reserve) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
    request.resume();
    throw new HttpError(415, 'Send the photo bytes with an image/* or application/octet-stream content type.');
  }
  const declaredSize = Number(request.headers['content-length'] || 0);
  if (declaredSize > MAX_UPLOAD_BYTES) {
    request.resume();
    throw new HttpError(413, 'Photo is over the 100 MB upload limit.');
  }
  if (declaredSize > remainingBytes) {
    request.resume();
    throw new HttpError(507, 'The server is out of temporary photo storage; clear or wait for old jobs.');
  }

  const output = createWriteStream(destination, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      reserve(chunk.length);
      if (size > MAX_UPLOAD_BYTES) {
        request.resume();
        throw new HttpError(413, 'Photo is over the 100 MB upload limit.');
      }
      if (size > remainingBytes) {
        request.resume();
        throw new HttpError(507, 'The server is out of temporary photo storage; clear or wait for old jobs.');
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
  const dataDir = path.resolve(options.dataDir || defaultDataDir());
  const jobsDir = path.join(dataDir, 'jobs');
  const ttlMinutes = options.ttlMinutes || 60;
  const maxTotalBytes = options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES;
  await checkVips();
  await ensurePrivateDirectory(dataDir);
  await ensurePrivateDirectory(jobsDir);

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
  const previewPath = (id) => path.join(jobDirectory(id), 'preview.jpg');
  const outputPath = (id, format) => path.join(jobDirectory(id), `output.${OUTPUT_FORMATS[format].extension}`);

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

  // Bytes held under jobs/ (sources, previews, outputs, work files in progress).
  async function storedBytes() {
    let total = 0;
    for (const entry of await readdir(jobsDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fileStats = await stat(path.join(entry.parentPath, entry.name)).catch(() => null);
      if (fileStats) total += fileStats.size;
    }
    return total;
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

  let inFlightBytes = 0;

  async function uploadPhoto(request, response) {
    const id = randomUUID();
    const directory = jobDirectory(id);
    const remainingBytes = maxTotalBytes - (await storedBytes()) - inFlightBytes;
    let reserved = 0;
    const reserve = (bytes) => {
      reserved += bytes;
      inFlightBytes += bytes;
    };
    await mkdir(directory, { mode: 0o700 });
    try {
      let sourceBytes;
      try {
        sourceBytes = await streamUpload(request, sourcePath(id), remainingBytes, reserve);
      } finally {
        inFlightBytes -= reserved;
      }
      const source = await readSource(sourcePath(id), directory);
      const preview = outputDimensions(source.width, source.height, PREVIEW_EDGE);
      try {
        await renderImage({
          autorotate: source.autorotate,
          flatten: true,
          height: preview.height,
          loader: source.loader,
          output: previewPath(id),
          save: { format: 'jpeg', quality: 82 },
          source: sourcePath(id),
          sourceHeight: source.height,
          sourceWidth: source.width,
          width: preview.width,
        });
      } catch (error) {
        if (error instanceof VipsError) throw new HttpError(415, unreadableMessage(source.format));
        throw error;
      }
      // The preview only goes back to the uploader, but it gets the same strict check.
      const previewCheck = verifyCleanImage(await readFile(previewPath(id)));
      if (!previewCheck.ok || previewCheck.width !== preview.width || previewCheck.height !== preview.height) {
        throw new Error(`Generated preview did not pass the metadata check (${previewCheck.problems.join(', ') || 'size mismatch'}).`);
      }

      const now = Date.now();
      const expiresAt = now + ttlMinutes * 60 * 1000;
      insertJobStatement.run(
        id,
        now,
        expiresAt,
        source.format,
        source.width,
        source.height,
        sourceBytes,
        source.metadataDetected ? 1 : 0,
      );
      sendJson(response, 201, {
        id,
        expiresAt,
        previewUrl: `/api/jobs/${id}/preview`,
        source: {
          bytes: sourceBytes,
          format: source.format,
          height: source.height,
          metadataDetected: source.metadataDetected,
          metadataStatus: source.metadataStatus,
          width: source.width,
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
    const temporaryPath = path.join(jobDirectory(id), `output-${randomUUID()}.tmp`);
    const finalPath = outputPath(id, settings.format);

    try {
      const output = await cleanImage({
        output: temporaryPath,
        settings,
        source: sourcePath(id),
        sourceFormat: job.source_format,
        sourceHeight: job.source_height,
        sourceWidth: job.source_width,
      });

      for (const entry of await readdir(jobDirectory(id))) {
        if (entry.startsWith('output.') && path.join(jobDirectory(id), entry) !== finalPath) {
          await unlink(path.join(jobDirectory(id), entry)).catch(() => {});
        }
      }
      await rename(temporaryPath, finalPath);
      updateOutputStatement.run(settings.format, output.width, output.height, output.bytes, id);
      sendJson(response, 200, {
        coverCount: settings.covers.length,
        decoy: output.decoy,
        downloadUrl: `/api/jobs/${id}/output?download=1`,
        expiresAt: job.expires_at,
        format: settings.format,
        height: output.height,
        outputUrl: `/api/jobs/${id}/output`,
        size: output.bytes,
        width: output.width,
      });
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function handleRequest(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD') rejectCrossSite(request);
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
      const status = error instanceof InputError ? error.status : 500;
      const message = error instanceof InputError ? error.message : 'The server could not process the photo.';
      if (!(error instanceof InputError)) {
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
    maxTotalBytes,
    server,
  };
}

function printHelp() {
  process.stdout.write(`FrameRinse self-hosted server\n\nUsage: node server.mjs [--host HOST] [--port PORT] [--data-dir PATH] [--max-total-mb MB]\n\nEnvironment:\n  FRAMERINSE_HOST              Bind address (default 0.0.0.0)\n  FRAMERINSE_PORT              Port (default 4173)\n  FRAMERINSE_DATA_DIR          Temporary job/database directory (default $XDG_STATE_HOME/framerinse or ~/.local/state/framerinse)\n  FRAMERINSE_JOB_TTL_MINUTES   Auto-delete delay (default 60)\n  FRAMERINSE_MAX_TOTAL_MB      Cap on stored job bytes before uploads get 507 (default 2048)\n`);
}

// Under systemd with Type=notify (NOTIFY_SOCKET is set), tell it the server is
// ready once it listens, through systemd's own tool. systemd-notify waits until
// systemd has the message, and the unit's NotifyAccess=all lets it send for us.
// Without NOTIFY_SOCKET (macOS, a plain npm start) nothing happens.
function notifyReady(env = process.env, run = execFile) {
  if (!env.NOTIFY_SOCKET) return false;
  run('systemd-notify', ['--ready'], { timeout: 10_000 }, (error) => {
    if (error) process.stderr.write(`systemd-notify --ready failed: ${error.message}\n`);
  });
  return true;
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
    notifyReady();
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

export { createFrameRinseServer, defaultDataDir, notifyReady, parseOptions, publicFiles, securityHeaders };
