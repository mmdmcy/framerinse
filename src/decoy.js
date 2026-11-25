// The optional decoy: a minimal, plausible EXIF block for a cleaned JPEG.
// Off by default; FrameRinse's purpose stays zero metadata. When asked for,
// the output carries exactly four fields and nothing else:
//   IFD0       Make, Model, DateTime
//   Exif IFD   DateTimeOriginal
// No GPS, maker notes, serial numbers, software tag, orientation or thumbnail
// (IFD0 links to no IFD1). Every field has a fixed length, so the block is the
// same size every day and only the date's ten characters change.

const MAKE = 'Apple';
const MODEL = 'iPhone 13';
// Day precision: the date of cleaning at a fixed noon, never the real time
// (see README, "The decoy").
const TIME = '12:00:00';

const ASCII = 2;
const LONG = 4;
const TAGS = { DateTime: 0x0132, DateTimeOriginal: 0x9003, ExifIFD: 0x8769, Make: 0x010f, Model: 0x0110 };

// "YYYY:MM:DD" in the local time zone, the form EXIF dates take.
function decoyDay(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}:${pad(now.getMonth() + 1)}:${pad(now.getDate())}`;
}

// The TIFF structure (big-endian, as phones write it): header, IFD0 with four
// entries, the Exif IFD with one, then the strings, all on even offsets.
function decoyTiff(day) {
  if (!/^\d{4}:\d{2}:\d{2}$/.test(day)) throw new Error(`decoy day must be YYYY:MM:DD, got ${JSON.stringify(day)}`);
  const dateTime = `${day} ${TIME}`;
  const strings = [MAKE, MODEL, dateTime, dateTime].map((text) => Buffer.from(`${text}\0`, 'latin1'));
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 4 * 12 + 4;
  let dataOffset = exifIfd + 2 + 12 + 4;
  const offsets = strings.map((string) => {
    const offset = dataOffset;
    dataOffset += string.length + (string.length % 2);
    return offset;
  });
  const tiff = Buffer.alloc(dataOffset);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0, 4);
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    tiff.writeUInt32BE(value, at + 8);
  };
  // Entries in ascending tag order, as TIFF requires.
  tiff.writeUInt16BE(4, ifd0);
  entry(ifd0 + 2, TAGS.Make, ASCII, strings[0].length, offsets[0]);
  entry(ifd0 + 14, TAGS.Model, ASCII, strings[1].length, offsets[1]);
  entry(ifd0 + 26, TAGS.DateTime, ASCII, strings[2].length, offsets[2]);
  entry(ifd0 + 38, TAGS.ExifIFD, LONG, 1, exifIfd);
  tiff.writeUInt32BE(0, ifd0 + 50); // no IFD1, so no thumbnail
  tiff.writeUInt16BE(1, exifIfd);
  entry(exifIfd + 2, TAGS.DateTimeOriginal, ASCII, strings[3].length, offsets[3]);
  tiff.writeUInt32BE(0, exifIfd + 14);
  strings.forEach((string, index) => string.copy(tiff, offsets[index]));
  return tiff;
}

// The whole APP1 segment, marker included: FF E1, length, "Exif\0\0", TIFF.
function decoySegment(day = decoyDay()) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), decoyTiff(day)]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// The JPEG with the segment right after its SOI marker.
function insertDecoy(jpeg, segment) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('the decoy goes into a JPEG only');
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

function decoyFields(day) {
  const dateTime = `${day} ${TIME}`;
  return { DateTime: dateTime, DateTimeOriginal: dateTime, Make: MAKE, Model: MODEL };
}

// When `jpeg` starts with a decoy segment exactly as decoySegment() writes it
// (for whichever day), returns { segment, fields }; otherwise null.
const DATE_AT = 4 + 6 + decoyTiff('2000:01:01').indexOf('2000:01:01');
function findDecoy(jpeg) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const day = jpeg.subarray(2 + DATE_AT, 2 + DATE_AT + 10).toString('latin1');
  if (!/^\d{4}:\d{2}:\d{2}$/.test(day)) return null;
  const segment = decoySegment(day);
  if (!jpeg.subarray(2, 2 + segment.length).equals(segment)) return null;
  return { fields: decoyFields(day), segment };
}

export { decoyDay, decoyFields, decoySegment, decoyTiff, findDecoy, insertDecoy };
