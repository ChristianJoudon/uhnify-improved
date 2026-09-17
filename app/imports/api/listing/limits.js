/**
 * How much a person may write, and how big a photo may be.
 *
 * One table, imported by the forms (as maxLength) and by the methods (as the
 * check that actually holds), so the two cannot drift apart: the old pages
 * capped a title at 80 on the client and the server accepted a title of any
 * length at all, which is the same as no cap. Nothing here is a design
 * decision about how long copy should be — these are ceilings, well above what
 * a real listing needs, that stop one field from becoming a place to store a
 * novel.
 */
export const TEXT_LIMITS = {
  title: 120,
  name: 80,
  description: 4000,
  location: 200,
  meetingTime: 160,
  contactInfo: 200,
  membership: 300,
  email: 254,
  bio: 600,
  firstName: 60,
  lastName: 60,
  profileTitle: 80,
  tag: 28,
  category: 40,
};

/**
 * How many entries a list a person fills — a group's tags, its categories —
 * may hold. The chip inputs stop at ten; the seed's longest list is shorter
 * than that. Twenty leaves room without letting a direct call make a list the
 * length of the collection.
 */
export const LIST_MAX_ENTRIES = 20;

/**
 * A photo is stored inline as a data URL and sent to every visitor with the
 * card, so its size is a cost paid by everyone, on every load. 700,000
 * characters is about 510 KB of JPEG — a phone photo shrunk to 1600px on its
 * long edge lands well under that. The old ceiling was 2,800,000, and it was
 * the only check.
 */
export const IMAGE_DATA_URL_MAX = 700000;
export const IMAGE_URL_MAX = 2048;

/** What the browser will bother decoding. A phone photo is three to eight
    megabytes; fifteen is a raw DSLR frame, and past that it is not a photo. */
export const UPLOAD_FILE_MAX_BYTES = 15 * 1024 * 1024;
/** The longest edge of a stored photo, and the JPEG quality it is written at.
    The largest card draws at a few hundred pixels; 1600 leaves room for a
    retina screen with nothing to spare for a poster nobody will print. */
export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_JPEG_QUALITY = 0.82;

/**
 * The first bytes of each format, which is the only thing a file cannot lie
 * about — a MIME type is whatever the uploader typed. WebP is RIFF, four bytes
 * of length that are anything at all, then WEBP; null stands for those.
 */
const SIGNATURES = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  webp: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
};

const DATA_URL_PREFIX = /^data:image\/(jpeg|png|webp);base64,/;

/** Twenty-four base64 characters are eighteen bytes; the longest signature
    needs twelve. The rest of the payload is never decoded. */
const HEAD_CHARS = 24;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 to bytes, for the head only. Written out rather than borrowed because
 * this module runs on both sides of the wire, and neither side has the other's
 * decoder: the server's Node has no atob, and the browser has a Buffer only
 * when the node stubs happen to have loaded first. Six bits in, eight bits
 * out is what the format is, so the bit operators the lint rule frowns on are
 * the plainest way to say it.
 */
/* eslint-disable no-bitwise */
const decodeHead = payload => {
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < Math.min(HEAD_CHARS, payload.length); i += 1) {
    const value = BASE64_ALPHABET.indexOf(payload[i]);
    if (value < 0) {
      break;
    }
    acc = ((acc << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return bytes;
};
/* eslint-enable no-bitwise */

const startsWithBytes = (bytes, signature) => signature.every((expected, i) => expected === null || bytes[i] === expected);

/**
 * Why a value may not be stored as a listing's image, or null when it may.
 *
 * Three shapes are allowed and nothing else: one of the app's own images, an
 * https URL, or an inline JPEG, PNG or WebP whose first bytes are what its
 * label says. The old check accepted any string starting with 'data:image/',
 * 'images/' or 'http' — so a 2.8 MB file of any real type, or a plain-http
 * link to anywhere, was stored and shipped to every visitor. A remote image is
 * a tracking pixel for everyone who opens the card, which is why the door is
 * as narrow as https and a length; plain http is refused outright, since a
 * browser will not draw it on an https page anyway.
 *
 * Returns a code rather than throwing, so it can be tested on its own and so
 * the caller decides what the person reads.
 */
export const imageProblem = value => {
  if (typeof value !== 'string' || value.length === 0) {
    return 'invalid-image';
  }
  if (value.startsWith('/images/') || value.startsWith('https://')) {
    return value.length <= IMAGE_URL_MAX ? null : 'invalid-image';
  }
  const match = DATA_URL_PREFIX.exec(value);
  if (!match) {
    return 'invalid-image';
  }
  if (value.length > IMAGE_DATA_URL_MAX) {
    return 'image-too-large';
  }
  const head = decodeHead(value.slice(match[0].length, match[0].length + HEAD_CHARS));
  return startsWithBytes(head, SIGNATURES[match[1]]) ? null : 'invalid-image';
};
