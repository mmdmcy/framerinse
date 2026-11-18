# Architecture

```text
iPhone photo
    |
    | raw HTTP upload on the self-hosted network
    v
temporary job directory + SQLite row
    |
    +--> vipsheader reads size and orientation; libvips orients and makes a small JPEG preview
    |         |
    |         +--> phone draws normalized solid-cover rectangles
    |
    +--> libvips resizes, paints covers, and encodes JPEG/PNG/WebP
              |
              +--> strict allow-list check of the whole output container
              +--> inline image and attachment download routes
```

The Node server binds to plain HTTP and exposes only the static app plus job API
routes. Uploads are written under a random job ID; source filenames are not
stored. SQLite records dimensions, format, expiration, and output state.

Jobs are removed explicitly by the UI or automatically after the configured
TTL. Startup cleanup removes expired database rows and orphan job directories.

The libvips command line (`vips`, `vipsheader`) performs full-resolution
decoding, HEIC included, run with argument arrays and timeouts in the job's
private folder (`src/vips.js`). The loader is named from the file's magic bytes,
and the size is checked against the 100 megapixel limit from the header alone. The browser receives a preview no larger than 1400 pixels on its
long edge. Cover coordinates are normalized, so the server can paint the same
rectangles into an output up to 4096 pixels.

The pixels pass through a bare raw copy, so the encoder receives an image with no
metadata at all, and it is also told to keep none. `src/metadata.js` then checks
the final container for known EXIF, XMP, IPTC, comment, text, and embedded-time
structures, and `src/verify.js` walks it completely, accepting only what is
needed to draw the pixels, before the output route is enabled.
