// Image work through the libvips command line (`vips`, `vipsheader`), run with
// argument arrays and timeouts, never through a shell. Every intermediate file
// lives in a private work folder inside the job's own folder.

import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const TOOL_TIMEOUT_MS = 120_000;

// The loader is named from the file's magic bytes, so a crafted file cannot
// choose another one. Keys are the job's stored source format names.
const LOADERS = {
  gif: 'gifload',
  heic: 'heifload',
  heif: 'heifload',
  jpeg: 'jpegload',
  png: 'pngload',
  tiff: 'tiffload',
  webp: 'webpload',
};

// detectContainer() name -> the format name the API reports (as before: AVIF is "heif").
const SOURCE_FORMATS = {
  avif: 'heif',
  gif: 'gif',
  heic: 'heic',
  jpeg: 'jpeg',
  png: 'png',
  tiff: 'tiff',
  webp: 'webp',
};

// vipsheader -f prints enums as "((VipsInterpretation) VIPS_INTERPRETATION_sRGB)".
const isSrgb = (value) => /\bVIPS_INTERPRETATION_sRGB\)$/.test(value || '');
const isUchar = (value) => /\bVIPS_FORMAT_UCHAR\)$/.test(value || '');

const METADATA_FIELDS = ['exif-data', 'xmp-data', 'iptc-data', 'orientation', 'jpeg-comment', 'gif-comment'];

class VipsError extends Error {}

function toolPath(name, env = process.env) {
  return env.FRAMERINSE_VIPS_DIR ? path.join(env.FRAMERINSE_VIPS_DIR, name) : name;
}

// untrustedInput: the call reads the uploaded file. libvips then refuses every
// loader it marks unsafe for untrusted input (ImageMagick, OpenSlide, its own
// .v format, ...). Calls on our own .v work files leave that off, as .v is one.
function run(tool, args, workDir, { untrustedInput = false } = {}) {
  const env = {
    ...process.env,
    // Any spill-to-disk file libvips makes stays in the job's private folder.
    TMPDIR: workDir,
  };
  if (untrustedInput) env.VIPS_BLOCK_UNTRUSTED = '1';
  else delete env.VIPS_BLOCK_UNTRUSTED;
  return new Promise((resolve, reject) => {
    execFile(
      toolPath(tool),
      args,
      { cwd: workDir, env, maxBuffer: 8 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed ? 'timed out' : String(stderr || error.message).trim().split('\n')[0];
          reject(new VipsError(`${tool} ${args[0]}: ${reason}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function checkVips() {
  try {
    const version = (await run('vips', ['--version'], process.cwd())).trim();
    if (!/^vips-8\./.test(version)) throw new VipsError(version);
    return version;
  } catch (error) {
    throw new Error(
      `FrameRinse needs the libvips command line (vips, vipsheader): install libvips-tools (Debian/Ubuntu) or vips (Homebrew), or set FRAMERINSE_VIPS_DIR to the folder holding them. (${error.message})`,
    );
  }
}

async function headerField(file, field, workDir, options) {
  try {
    return (await run('vipsheader', ['-f', field, file], workDir, options)).trim();
  } catch {
    return null;
  }
}

// Header only, no pixels decoded. The values that matter (loader, size,
// orientation) are read one field at a time so text inside metadata cannot
// pose as another field.
async function readSourceHeader(file, workDir) {
  const untrusted = { untrustedInput: true };
  const [loader, width, height, orientation, all] = await Promise.all([
    headerField(file, 'vips-loader', workDir, untrusted),
    headerField(file, 'width', workDir, untrusted),
    headerField(file, 'height', workDir, untrusted),
    headerField(file, 'orientation', workDir, untrusted),
    run('vipsheader', ['-a', file], workDir, untrusted).catch(() => ''),
  ]);
  const names = new Set(all.split('\n').map((line) => line.slice(0, line.indexOf(':'))));
  const metadataPresent =
    METADATA_FIELDS.some((field) => names.has(field)) || [...names].some((name) => name.startsWith('png-comment-'));
  return {
    height: Number(height),
    loader,
    metadataPresent,
    orientation: Number(orientation) || 1,
    width: Number(width),
  };
}

function coverRectangles(covers, width, height) {
  return covers.map((cover) => {
    const x = Math.max(0, Math.floor(cover.x * width) - 1);
    const y = Math.max(0, Math.floor(cover.y * height) - 1);
    const right = Math.min(width, Math.ceil((cover.x + cover.width) * width) + 1);
    const bottom = Math.min(height, Math.ceil((cover.y + cover.height) * height) + 1);
    return { height: bottom - y, width: right - x, x, y };
  });
}

function saveArguments(save) {
  if (save.format === 'jpeg') {
    // 4:2:0 chroma at every quality, as before; exports progressive, previews baseline, as before.
    const options = ['jpegsave', '--Q', String(save.quality), '--optimize-coding', '--subsample-mode', 'on', '--keep', 'none'];
    if (save.progressive) options.push('--interlace');
    return options;
  }
  if (save.format === 'png') return ['pngsave', '--compression', '9', '--filter', 'none', '--keep', 'none'];
  return ['webpsave', '--Q', String(save.quality), '--keep', 'none'];
}

// Load the first frame with the named loader, orient it, bring it to 8-bit
// sRGB, resize to exactly width x height, paint covers, flatten alpha when
// asked, and save with no metadata kept.
async function renderImage({ autorotate, covers = [], flatten, height, loader, output, save, source, sourceHeight: orientedHeight, sourceWidth: orientedWidth, width }) {
  const workDir = path.join(path.dirname(output), `work-${path.basename(output)}`);
  await mkdir(workDir, { mode: 0o700 });
  let step = 0;
  let current = source;
  const next = async (operation, ...args) => {
    step += 1;
    const file = path.join(workDir, `${step}.v`);
    await run('vips', [operation, current, file, ...args], workDir, { untrustedInput: current === source });
    if (current !== source) await rm(current, { force: true });
    current = file;
  };
  const fields = (...names) => Promise.all(names.map((name) => headerField(current, name, workDir)));

  try {
    // Shrink-on-load, as before: JPEG and WebP decode at 1/2, 1/4, or 1/8 size
    // when the output is at least that much smaller. Faster, and less memory.
    const shrink = Math.min(orientedWidth / width, orientedHeight / height);
    const loadFactor = shrink >= 8 ? 8 : shrink >= 4 ? 4 : shrink >= 2 ? 2 : 1;
    const loadOptions = ['--fail-on', 'warning'];
    if (loadFactor > 1 && loader === 'jpegload') loadOptions.push('--shrink', String(loadFactor));
    if (loadFactor > 1 && loader === 'webpload') loadOptions.push('--scale', String(1 / loadFactor));
    await next(loader, ...loadOptions);
    const [orientation, icc, interpretation, format] = await fields('orientation', 'icc-profile-data', 'interpretation', 'format');
    if (autorotate && Number(orientation) > 1) await next('autorot');
    if (icc) await next('icc_transform', 'srgb', '--embedded', '--intent', 'perceptual', '--depth', '8');
    else if (!isSrgb(interpretation)) await next('colourspace', 'srgb');
    if (!isUchar(format)) {
      const [converted] = await fields('format');
      if (!isUchar(converted)) await next('cast', 'uchar');
    }

    const [bandText, widthText, heightText, finalInterpretation] = await fields('bands', 'width', 'height', 'interpretation');
    if (!isSrgb(finalInterpretation)) throw new VipsError(`could not convert ${finalInterpretation} to sRGB`);
    const bands = Number(bandText);
    const hasAlpha = bands === 4;
    if (bands !== 3 && bands !== 4) throw new VipsError(`unexpected band count ${bands}`);
    const sourceWidth = Number(widthText);
    const sourceHeight = Number(heightText);

    // Drop every metadata field before any further step: the pixels go out as
    // bare bytes and come back as a new image that has nothing else. The savers'
    // keep=none is not enough on its own (libvips 8.15 still writes PNG text).
    const raw = path.join(workDir, 'pixels.raw');
    await run('vips', ['rawsave', current, raw], workDir);
    if (current !== source) await rm(current, { force: true });
    step += 1;
    current = path.join(workDir, `${step}.v`);
    await run(
      'vips',
      ['rawload', raw, current, String(sourceWidth), String(sourceHeight), String(bands), '--format', 'uchar', '--interpretation', 'srgb'],
      workDir,
    );
    await rm(raw, { force: true });

    if (sourceWidth !== width || sourceHeight !== height) {
      const scale = [String(width / sourceWidth), '--vscale', String(height / sourceHeight)];
      if (hasAlpha) {
        await next('premultiply');
        await next('resize', ...scale);
        await next('unpremultiply');
        await next('cast', 'uchar');
      } else {
        await next('resize', ...scale);
      }
      const [resizedWidth, resizedHeight] = (await fields('width', 'height')).map(Number);
      if (resizedWidth !== width || resizedHeight !== height) {
        throw new VipsError(`resize gave ${resizedWidth}x${resizedHeight}, expected ${width}x${height}`);
      }
    }

    if (covers.length) {
      const ink = hasAlpha ? '5 7 6 255' : '5 7 6';
      for (const rectangle of coverRectangles(covers, width, height)) {
        // draw_rect paints in place, so the .v file is changed directly.
        await run(
          'vips',
          ['draw_rect', current, ink, String(rectangle.x), String(rectangle.y), String(rectangle.width), String(rectangle.height), '--fill'],
          workDir,
        );
      }
    }
    if (flatten && hasAlpha) await next('flatten', '--background', '255 255 255');

    const [saver, ...saveOptions] = saveArguments(save);
    const saved = path.join(workDir, 'saved');
    await run('vips', [saver, current, saved, ...saveOptions], workDir);
    await rename(saved, output);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

export { checkVips, LOADERS, readSourceHeader, renderImage, SOURCE_FORMATS, VipsError };
