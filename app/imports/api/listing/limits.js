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
 * The shape every email address has: one @, a dotted domain, no whitespace.
 * Anything stricter turns away real addresses. Here, beside the length it is
 * always checked with, because two places ask — a listing's contact email and
 * the address an account signs up under — and a second copy of a pattern like
 * this is the one that gets "improved".
 */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * How many entries a list a person fills — a group's tags, its categories —
 * may hold. The chip inputs stop at ten; the seed's longest list is shorter
 * than that. Twenty leaves room without letting a direct call make a list the
 * length of the collection.
 */
export const LIST_MAX_ENTRIES = 20;

/**
 * A photo arrives as a data URL, and 700,000 characters of one is about
 * 510 KB of JPEG — a phone photo shrunk to 1600px on its long edge lands well
 * under that. The old ceiling was 2,800,000, and it was the only check.
 *
 * It used to be stored as it arrived, on the listing, and so was sent to every
 * visitor with the card on every load. It is kept in its own collection now
 * (api/photos) and the listing carries a path; the ceiling is still what one
 * upload may cost the server, and what one <img> may cost a phone.
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
 * Where an uploaded photo is served from: `/photo/<kind>/<ownerId>?v=<ms>`.
 *
 * The kind says which collection the owner lives in, the owner is the _id of
 * the document whose field holds the path, and `v` is the moment the photo
 * was last replaced. The server never reads `v`. It is there so that the
 * address changes whenever the picture does, which is what lets the route
 * tell a browser to keep the bytes for a year without ever showing anybody a
 * stale one.
 *
 * The owner's shape is what Meteor's ids are and a little more, and nothing
 * that could mean something to a filesystem, a query or a URL parser. The
 * route answers 404 to anything else without opening the database, and
 * nothing is ever stored under an id the route would refuse to serve.
 */
export const PHOTO_KINDS = ['event', 'club', 'profile'];
export const PHOTO_OWNER_ID = /^[A-Za-z0-9]{1,40}$/;
const PHOTO_PATH_PREFIX = '/photo/';
const PHOTO_PATH = /^\/photo\/(event|club|profile)\/([A-Za-z0-9]{1,40})(?:\?v=\d{1,16})?$/;

export const photoPathFor = ({ kind, ownerId, updatedAt }) => `${PHOTO_PATH_PREFIX}${kind}/${ownerId}?v=${updatedAt.getTime()}`;

/** Meant as a photo path — which is not the same as being a good one; that
    is parsePhotoPath. The UI's twin is isPhoto in ui/utilities/helpers.js. */
export const isPhotoPath = value => typeof value === 'string' && value.startsWith(PHOTO_PATH_PREFIX);

/** Whose photo a path names, or null when it is not a path the app wrote. */
export const parsePhotoPath = value => {
  const match = typeof value === 'string' ? PHOTO_PATH.exec(value) : null;
  return match ? { kind: match[1], ownerId: match[2] } : null;
};

/**
 * Why a value may not be stored as a listing's image, or null when it may.
 *
 * Four shapes are allowed and nothing else: one of the app's own images, an
 * https URL, the path of a photo already uploaded, or an inline JPEG, PNG or
 * WebP whose first bytes are what its label says. A photo path passes on its
 * shape alone, because shape is all this module can see: WHOSE photo it names
 * is a question for the server, and photoFieldFor (api/photos/photoStore.js)
 * is where one listing is stopped from pointing at another's.
 *
 * The old check accepted any string starting with 'data:image/',
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
  if (isPhotoPath(value)) {
    return parsePhotoPath(value) ? null : 'invalid-image';
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

/**
 * An inline image taken apart: the type its label claims, and the base64 that
 * follows the comma. Null for anything that is not one of the three formats.
 * Says nothing about whether the two agree — that is imageProblem, and nothing
 * should be split that it has not passed.
 */
export const splitImageDataUrl = value => {
  const match = typeof value === 'string' ? DATA_URL_PREFIX.exec(value) : null;
  return match ? { contentType: `image/${match[1]}`, data: value.slice(match[0].length) } : null;
};
