# Architecture

```text
iPhone photo
    |
    | raw HTTP upload on the self-hosted network
    v
temporary job directory + SQLite row
    |
    +--> HEIC fallback / Sharp auto-orient and make a small JPEG preview
    |         |
    |         +--> phone draws normalized solid-cover rectangles
    |
    +--> Sharp resizes, paints covers, and encodes JPEG/PNG/WebP
              |
              +--> byte-level output metadata check
              +--> inline image and attachment download routes
```

The Node server binds to plain HTTP and exposes only the static app plus job API
routes. Uploads are written under a random job ID; source filenames are not
stored. SQLite records dimensions, format, expiration, and output state.

Jobs are removed explicitly by the UI or automatically after the configured
TTL. Startup cleanup removes expired database rows and orphan job directories.

Sharp performs full-resolution decoding, with a server-side HEIC decoder used
when needed. The browser receives a preview no larger than 1400 pixels on its
long edge. Cover coordinates are normalized, so the server can paint the same
rectangles into an output up to 4096 pixels.

Sharp re-encodes without requesting source metadata. `src/metadata.js` then
checks the final JPEG, PNG, or WebP container for known EXIF, XMP, IPTC, comment,
text, and embedded-time structures before the output route is enabled.
