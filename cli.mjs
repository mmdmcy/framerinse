#!/usr/bin/env node
// framerinse: the server's cleaning pipeline on the command line.

import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { cleanImage, InputError, inspectFile, MAX_EDGES, OUTPUT_FORMATS, readSource, validateScrubSettings } from './src/pipeline.js';
import { checkVips } from './src/vips.js';

const HELP = `framerinse: clean a photo, or check what metadata a file carries.

Usage:
  framerinse clean IN [-o OUT] [--format jpeg|png|webp] [--max-size 1080|2048|4096]
                      [--quality 65-100] [--cover x,y,w,h]... [--decoy] [--json]
  framerinse check FILE [--json]

clean   Rotates the photo upright, resizes it, paints solid covers, and
        re-encodes it with no metadata, then checks the new file byte by byte.
        The file is written only when that check passes.
          -o, --output OUT   where to write (default IN's folder, NAME-clean.EXT);
                             an existing file is never overwritten
          --format F         jpeg, png, or webp (default: from OUT's extension, else jpeg)
          --max-size N       longest edge: 1080, 2048, or 4096 (default 2048);
                             a smaller photo keeps its size
          --quality Q        JPEG and WebP quality, 65 to 100 (default 90)
          --cover x,y,w,h    a solid rectangle in pixels of the upright photo,
                             from its top-left corner; repeat for more (at most 50)
          --decoy            JPEG only, off by default: add minimal made-up EXIF
                             (a generic phone's Make and Model, today's date at
                             noon; no location) instead of none. No metadata at
                             all, the default, is the recommended choice.
check   Lists what FILE carries besides its pixels: EXIF, GPS, maker notes,
        XMP, IPTC, ICC profiles, comments, text, timestamps, and anything else
        the strict check refuses (JPEG, PNG, WebP: the same walk an export must
        pass; other formats: what libvips reads from the header). A --decoy
        output is reported as exif, with the decoy's fields.

  --json  machine-readable output, errors too
  -h, --help

Exit codes: 0 done (check: nothing found), 1 failed, 2 usage error,
4 check found something.

Needs the libvips command line (vips, vipsheader) on PATH, or FRAMERINSE_VIPS_DIR.

Examples:
  framerinse clean IMG_0042.HEIC -o share.jpg --cover 120,80,300,60
  framerinse clean scan.png --format webp --max-size 1080 --json
  framerinse clean IMG_0042.HEIC -o share.jpg --decoy
  framerinse check share.jpg && echo clean
`;

class UsageError extends Error {}

const EXTENSIONS = { '.jpeg': 'jpeg', '.jpg': 'jpeg', '.png': 'png', '.webp': 'webp' };

function parseCover(text) {
  const parts = text.split(',').map((part) => part.trim());
  const numbers = parts.map(Number);
  if (parts.length !== 4 || parts.some((part) => part === '') || numbers.some((value) => !Number.isFinite(value))) {
    throw new UsageError(`--cover takes x,y,w,h in pixels, such as 10,20,300,40 (got ${JSON.stringify(text)}).`);
  }
  const [x, y, width, height] = numbers;
  return { height, width, x, y };
}

function parseCommand(argv) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      cover: { multiple: true, type: 'string' },
      decoy: { type: 'boolean' },
      format: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      json: { type: 'boolean' },
      'max-size': { type: 'string' },
      output: { short: 'o', type: 'string' },
      quality: { type: 'string' },
    },
  });
  const [command, file, ...rest] = positionals;
  if (values.help || !command || command === 'help') return { command: 'help' };
  if (command !== 'clean' && command !== 'check') throw new UsageError(`Unknown command: ${command}. Run framerinse --help.`);
  if (!file) throw new UsageError(`framerinse ${command} needs a file. Run framerinse --help.`);
  if (rest.length) throw new UsageError(`One file at a time; unexpected: ${rest.join(' ')}`);
  if (command === 'check') {
    const extra = ['cover', 'decoy', 'format', 'max-size', 'output', 'quality'].filter((name) => values[name] !== undefined);
    if (extra.length) throw new UsageError(`framerinse check takes no --${extra[0]}.`);
    return { command, file, json: Boolean(values.json) };
  }

  const format = values.format ?? EXTENSIONS[path.extname(values.output || '').toLowerCase()] ?? 'jpeg';
  if (!OUTPUT_FORMATS[format]) throw new UsageError('--format must be jpeg, png, or webp.');
  const maxEdge = Number(values['max-size'] ?? 2048);
  if (!MAX_EDGES.includes(maxEdge)) throw new UsageError(`--max-size must be ${MAX_EDGES.join(', ')}.`);
  const quality = Number(values.quality ?? 90);
  if (!Number.isInteger(quality) || quality < 65 || quality > 100) throw new UsageError('--quality must be a whole number from 65 to 100.');
  const decoy = Boolean(values.decoy);
  if (decoy && format !== 'jpeg') throw new UsageError('--decoy writes EXIF to JPEG only; use --format jpeg or leave --decoy off.');
  const covers = (values.cover || []).map(parseCover);
  const input = path.resolve(file);
  const parsed = path.parse(input);
  const output = path.resolve(values.output || path.join(parsed.dir, `${parsed.name}-clean.${OUTPUT_FORMATS[format].extension}`));
  if (output === input) throw new UsageError('The output cannot be the input file.');
  return { command, covers, decoy, format, input, json: Boolean(values.json), maxEdge, output, quality };
}

// The input is reached through a link named "source" in a private work folder,
// so libvips never sees the user's file name (it would read "[...]" in a name
// as load options), and every work file stays in that folder.
async function withWorkFolder(input, run) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'framerinse-'));
  try {
    const source = path.join(workDir, 'source');
    await symlink(path.resolve(input), source);
    return await run(source, workDir);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function clean(options) {
  await access(options.input, constants.R_OK).catch(() => {
    throw new InputError(1, `Cannot read ${options.input}.`);
  });
  if (await exists(options.output)) throw new InputError(1, `${options.output} already exists; choose another -o.`);
  await checkVips();
  return withWorkFolder(options.input, async (source, workDir) => {
    const info = await readSource(source, workDir);
    // Pixel covers become the normalized rectangles the server takes, and go
    // through the same validation.
    const settings = validateScrubSettings({
      covers: options.covers.map((cover) => ({
        height: cover.height / info.height,
        width: cover.width / info.width,
        x: cover.x / info.width,
        y: cover.y / info.height,
      })),
      decoy: options.decoy,
      format: options.format,
      maxEdge: options.maxEdge,
      quality: options.quality,
    });
    const rendered = path.join(workDir, `output.${OUTPUT_FORMATS[options.format].extension}`);
    const result = await cleanImage({
      output: rendered,
      settings,
      source,
      sourceFormat: info.format,
      sourceHeight: info.height,
      sourceWidth: info.width,
    });
    await copyFile(rendered, options.output, constants.COPYFILE_EXCL);
    return {
      bytes: result.bytes,
      check: 'passed',
      covers: settings.covers.length,
      decoy: result.decoy,
      format: options.format,
      height: result.height,
      input: options.input,
      output: options.output,
      source: { format: info.format, height: info.height, metadata: info.metadataStatus, width: info.width },
      width: result.width,
    };
  });
}

async function check(options) {
  const file = path.resolve(options.file);
  await access(file, constants.R_OK).catch(() => {
    throw new InputError(1, `Cannot read ${file}.`);
  });
  await checkVips();
  const report = await withWorkFolder(file, (source, workDir) => inspectFile(source, workDir));
  return { file, ...report };
}

function cleanText(result) {
  const covers = result.covers ? `, ${result.covers} cover${result.covers === 1 ? '' : 's'}` : '';
  const sourceMetadata = { detected: 'metadata removed', 'not-detected': 'no metadata seen in the source', 'not-fully-checked': 'source metadata not fully read; none kept' }[result.source.metadata];
  const decoy = result.decoy ? `; decoy EXIF added (${result.decoy.Make} ${result.decoy.Model}, ${result.decoy.DateTimeOriginal})` : '';
  return `${result.output}: ${result.format} ${result.width}x${result.height}, ${result.bytes} bytes${covers}; ${sourceMetadata}${decoy}; byte check passed\n`;
}

function checkText(report) {
  const size = report.width ? ` ${report.width}x${report.height}` : '';
  const head = `${report.file}: ${report.container}${size}`;
  const scope = report.fullyChecked ? '' : ' (header only: libvips read what it could; this format is not walked byte by byte)';
  if (!report.found.length) return `${head}: nothing found${scope}\n`;
  const fields = (item) => Object.entries(item.fields || {}).map(([name, value]) => `             ${name}: ${value}\n`).join('');
  return `${head}: found${scope}\n${report.found.map((item) => `  ${item.kind.padEnd(10)} ${item.label}\n${fields(item)}`).join('')}`;
}

async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  let options;
  try {
    options = parseCommand(argv);
  } catch (error) {
    const json = argv.includes('--json');
    if (json) out.write(`${JSON.stringify({ error: { code: 'usage', message: error.message } })}\n`);
    else err.write(`${error.message}\n`);
    return 2;
  }
  if (options.command === 'help') {
    out.write(HELP);
    return 0;
  }
  try {
    if (options.command === 'clean') {
      const result = await clean(options);
      out.write(options.json ? `${JSON.stringify(result)}\n` : cleanText(result));
      return 0;
    }
    const report = await check(options);
    out.write(options.json ? `${JSON.stringify({ ...report, clean: report.found.length === 0 })}\n` : checkText(report));
    return report.found.length ? 4 : 0;
  } catch (error) {
    const code = error instanceof InputError ? 'refused' : 'failed';
    if (options.json) out.write(`${JSON.stringify({ error: { code, message: error.message } })}\n`);
    else err.write(`framerinse ${options.command}: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = await main();
