# FrameRinse

FrameRinse is a plain-HTTP, self-hosted photo cleaner. The iPhone uploads the
original to your server; the server uses the libvips command line to rotate,
resize, cover details, and re-encode without metadata, then checks the exported
JPEG, PNG, or WebP itself, byte by byte. SQLite tracks temporary jobs and
automatic cleanup. It has no npm dependencies: only Node's built-ins and libvips.

Zero metadata is what FrameRinse is for, and the default. An optional decoy
(below) can add a few made-up EXIF fields to a JPEG instead; it is off unless
you ask for it.

The phone only decodes a small server-generated preview and the finished image.

## Run

Requires Node.js 24.15 or newer and the libvips command-line tools (`vips` and
`vipsheader`, libvips 8.15 or newer, built with HEIF support for HEIC photos):

```sh
sudo apt install libvips-tools   # Debian, Ubuntu
brew install vips                # macOS (Homebrew)
```

There is nothing to `npm install`:

```sh
npm start
```

FrameRinse finds `vips` and `vipsheader` on `PATH`. To use another copy, set
`FRAMERINSE_VIPS_DIR` to the folder that holds both. The server refuses to start
when they are missing.

FrameRinse listens on `0.0.0.0:4173`. From an iPhone on the same network, open:

```text
http://<server-address>:4173
```

Choose a photo, add any solid covers, and tap **Scrub photo**. To put the result
in the iPhone camera roll, tap **Open to save to Photos**, press and hold the
full image, then choose **Save to Photos**.

## Command line

The same pipeline runs without the server, on a file:

```sh
node cli.mjs clean IMG_0042.HEIC -o share.jpg --cover 120,80,300,60
node cli.mjs check share.jpg
```

`npm link` (or `npm install -g .`) puts it on `PATH` as `framerinse`.

```text
framerinse clean IN [-o OUT] [--format jpeg|png|webp] [--max-size 1080|2048|4096]
                    [--quality 65-100] [--cover x,y,w,h]... [--decoy] [--json]
framerinse check FILE [--json]
```

- `clean` rotates, resizes, paints solid covers, and re-encodes the photo with
  the server's own code, then runs the same byte-by-byte check. The file is
  written only when the check passes; otherwise it exits 1. The output defaults
  to `NAME-clean.jpg` next to the input, and an existing file is never
  overwritten. `--format` defaults to the output's extension, else JPEG.
  A cover is `x,y,w,h` in pixels of the upright photo, from its top-left
  corner; repeat `--cover` for more. `--decoy` adds the decoy EXIF (JPEG only;
  see below).
- `check` lists what a file carries besides its pixels (EXIF, GPS, maker notes,
  XMP, IPTC, ICC profiles, comments, text, timestamps, and anything else the
  strict check refuses) and exits 4 when it finds any, 0 when none. JPEG, PNG,
  and WebP are walked byte by byte; other formats (HEIC, TIFF, GIF) are read
  from their libvips header only. A decoy output is reported as `exif`, with
  the decoy's fields, and exits 4: it does carry metadata.

`--json` gives machine output, errors too. Exit codes: 0 done, 1 failed,
2 usage error, 4 `check` found something. Work files go in a private folder
under `$TMPDIR` that is removed when the command ends.

## Running under systemd

When `NOTIFY_SOCKET` is set, the server runs `systemd-notify --ready` once it
listens, so a unit can use systemd's own readiness instead of polling the port:

```ini
[Service]
Type=notify
NotifyAccess=all
```

`NotifyAccess=all` is needed because the message comes from `systemd-notify`,
a child of the server. Without `NOTIFY_SOCKET` (macOS, `npm start`) nothing
happens.

## Temporary storage

By default, FrameRinse stores its SQLite database and job files under
`$XDG_STATE_HOME/framerinse` (usually `~/.local/state/framerinse`), created
with mode `0700`. An existing directory is used only if the current user owns
it; its mode is tightened to `0700`, and the server refuses to start on a
directory owned by someone else. A job contains the original, small preview,
and latest output. Tap **Clear everything** to delete it immediately; otherwise
it expires after 60 minutes.

Stored job bytes are capped (2 GB by default); uploads beyond the cap get
`507` until jobs are cleared or expire. Uploads must be sent as `image/*` or
`application/octet-stream`, and browser requests from another site are refused
(`403`) based on the `Origin` and `Sec-Fetch-Site` headers. There is still no
login: anyone on the LAN who can reach the port can use the server.

Configuration:

```text
FRAMERINSE_HOST=0.0.0.0
FRAMERINSE_PORT=4173
FRAMERINSE_DATA_DIR=/path/to/private/runtime/storage
FRAMERINSE_JOB_TTL_MINUTES=60
FRAMERINSE_MAX_TOTAL_MB=2048
FRAMERINSE_VIPS_DIR=/path/to/folder/with/vips   # optional; PATH otherwise
```

The server accepts photos up to 100 MB and 100 megapixels. The size is read
from the file's header before any pixel is decoded. It processes the first frame
of animated inputs.

## How the metadata goes

- The decoder is chosen from the file's first bytes (JPEG, PNG, WebP, GIF, TIFF,
  HEIC, AVIF), never from its name or content type, and must match what libvips
  itself reads; libvips' loaders that are unsafe for untrusted input are blocked.
- After rotation and conversion to 8-bit sRGB, the pixels are written out as bare
  bytes and read back as a new image, so no metadata field reaches the encoder.
  The encoder is also told to keep none.
- Every export and preview is then walked by `src/verify.js`, which accepts only
  the structures needed to show the image (JPEG frame, tables, scans and a plain
  JFIF header; PNG header, palette, data, transparency, colour and resolution
  chunks; WebP image and alpha chunks) and refuses everything else: EXIF, XMP,
  IPTC, ICC profiles, comments, text, timestamps, thumbnails, unknown chunks and
  bytes after the end. An export that fails is not served.
- All intermediate files live in the job's own private folder and are removed
  when the step ends.

## The decoy (optional)

Off by default. With **Add a decoy** in the web app, `--decoy` on the command
line, or `"decoy": true` in the scrub request, a JPEG export gets four EXIF
fields and nothing else:

- `Make` `Apple` and `Model` `iPhone 13`: one fixed pair for every photo and
  every user, so it says nothing about your own phone, and two decoy photos
  cannot be told apart by it. It is a widely sold phone, a few generations old,
  that is still in common use, so the pair is about as unremarkable as a phone
  answer gets.
- `DateTime` and `DateTimeOriginal`: the day of cleaning (the server's local
  date) at a fixed `12:00:00`. Day precision, not the real time: the real time
  would record the moment you cleaned the photo to the second, which is the
  timing trail FrameRinse advises breaking. The fixed noon is itself a tell to
  anyone who looks closely; that is the price of not recording the time.

Nothing else: no GPS, no maker notes, no serial numbers, no software tag, no
thumbnail (IFD0 links to no second directory), and no `Orientation` tag, as the
pixels are already upright and an absent tag means 1. The block is written in
plain JS (`src/decoy.js`) as an APP1 segment right after the JPEG's start
marker. The strict check then accepts exactly that segment, compared byte for
byte with what the writer made, and still refuses everything else, a second
EXIF segment included. (Readers built on libexif, libvips among them, also list
mandatory defaults such as `ExifVersion` and the resolution when they read it;
those are assumed by the reader, not stored in the file.)

PNG and WebP exports refuse the option with a clear error. Phone cameras do not
write PNG or WebP, so camera EXIF in one would stand out rather than blend in;
JPEG is where the decoy is plausible.

Why zero metadata stays the default and the decoy only an option:

- A photo with no metadata already blends in. Messengers and most social sites
  strip EXIF when a photo is shared, so a bare JPEG looks like the many photos
  that went through one.
- Fake values can be told apart from real ones. A real phone writes dozens of
  fields (exposure, lens, software version, sub-second time, maker notes);
  four fields with a noon timestamp look made up to anyone who checks.
- A decoy adds a claim (this phone, this day) that may be wrong in a way that
  matters to you. No metadata makes no claim at all.

## Checks

```sh
npm test
npm run check
```

The tests need `vips` as above. They cover SQLite job lifecycle, the command
line (clean, check, and a failed byte check), the decoy (its writer read back,
the strict check refusing a changed decoy, and decoy off leaving the output
byte for byte as before), EXIF
orientation, HEIC input, server previews, solid covers, JPEG/PNG/WebP exports,
PNG text removal, the pixel limit, the strict output check on hand-made files,
cleanup, and private-file containment.

Metadata removal does not make the visible photo anonymous. Faces, reflections,
documents, landmarks, tattoos, and other visible details can still identify a
person or location.

This repository is prepared for public source hosting. Runtime photos,
databases, environment files, and private notes are ignored.
