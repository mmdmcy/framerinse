# FrameRinse

FrameRinse is a plain-HTTP, self-hosted photo cleaner. The iPhone uploads the
original to your server; the server uses Sharp plus a HEIC decoder to rotate,
resize, cover details, strip common metadata, and verify the exported JPEG,
PNG, or WebP. SQLite tracks temporary jobs and automatic cleanup.

The phone only decodes a small server-generated preview and the finished image.

## Run

Requires Node.js 24.15 or newer.

```sh
npm install
npm start
```

FrameRinse listens on `0.0.0.0:4173`. From an iPhone on the same network, open:

```text
http://<server-address>:4173
```

Choose a photo, add any solid covers, and tap **Scrub photo**. To put the result
in the iPhone camera roll, tap **Open to save to Photos**, press and hold the
full image, then choose **Save to Photos**.

## Temporary storage

By default, FrameRinse stores its SQLite database and job files under
`/tmp/framerinse`. A job contains the original, small preview, and latest output.
Tap **Clear everything** to delete it immediately; otherwise it expires after
60 minutes.

Configuration:

```text
FRAMERINSE_HOST=0.0.0.0
FRAMERINSE_PORT=4173
FRAMERINSE_DATA_DIR=/path/to/private/runtime/storage
FRAMERINSE_JOB_TTL_MINUTES=60
```

The server accepts photos up to 100 MB and 100 megapixels. It processes the
first frame of animated inputs.

## Checks

```sh
npm test
npm run check
```

The tests cover SQLite job lifecycle, EXIF orientation, HEIC input, server
previews, solid covers, JPEG/PNG/WebP exports, metadata verification, cleanup,
and private-file containment.

Metadata removal does not make the visible photo anonymous. Faces, reflections,
documents, landmarks, tattoos, and other visible details can still identify a
person or location.

This repository is prepared for public source hosting. Runtime photos,
databases, environment files, and private notes are ignored.
