import {
  IMAGE_DATA_URL_MAX,
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE,
  UPLOAD_FILE_MAX_BYTES,
} from '../../api/listing/limits';

/**
 * A photo, made small before it ever leaves the page.
 *
 * The forms used to read the chosen file with FileReader as-is and post the
 * result, after refusing anything over 2 MB. A phone photo is three to eight
 * megabytes, so real people were turned away with "too large" while a small
 * file of any content at all went straight into the database. The server now
 * accepts only a JPEG, PNG or WebP under IMAGE_DATA_URL_MAX, and this is how
 * an ordinary photo gets under it: decoded here, scaled to IMAGE_MAX_EDGE on
 * its long side, written out as JPEG. If that is still too long the photo is
 * tried again at 1200 and then 900 pixels, which is smaller than any card
 * draws it but still a photo; a file that will not fit even then is not one
 * we can use, and the caller is told so in words meant for a person.
 */

/** JPEG has no alpha channel, so every transparent pixel in a source becomes
    BLACK on export — a logo on a clear background comes out in a black box.
    Painting the page's paper colour first flattens it the way a photo would
    have looked, and it is the colour the card is drawn on anyway. */
const PAPER = '#fcfcfb';
const SMALLER_EDGES = [1200, 900];

/**
 * createImageBitmap honours the EXIF orientation a phone writes instead of
 * the pixels' own order, which is why a portrait shot does not come out on
 * its side. Where it is missing, or refuses the file, an <img> from an object
 * URL is the fallback; the URL is released either way, since each one holds
 * the whole file in memory until it is.
 */
const decode = async file => {
  if (typeof window.createImageBitmap === 'function') {
    try {
      return await window.createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (error) {
      // Fall through: the <img> route may still read what the bitmap decoder
      // would not, and if it cannot, that is the error worth reporting.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not a photo we can read.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

const render = (source, maxEdge, quality) => {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
};

const fitWithin = (source, quality, [edge, ...smaller]) => {
  const dataUrl = render(source, edge, quality);
  if (dataUrl.length <= IMAGE_DATA_URL_MAX) {
    return dataUrl;
  }
  if (smaller.length === 0) {
    throw new Error('That photo could not be made small enough. Try a simpler one.');
  }
  return fitWithin(source, quality, smaller);
};

/** The chosen file as a JPEG data URL the server will accept, or a rejection
    whose message can be shown as it is. */
export const shrinkImage = async (file, { maxEdge = IMAGE_MAX_EDGE, quality = IMAGE_JPEG_QUALITY } = {}) => {
  if (!file || !`${file.type}`.startsWith('image/')) {
    throw new Error('Please choose a photo — a JPEG, PNG or WebP.');
  }
  if (file.size > UPLOAD_FILE_MAX_BYTES) {
    throw new Error('That file is too large to read. Try one under 15 MB.');
  }
  const source = await decode(file);
  try {
    return fitWithin(source, quality, [maxEdge, ...SMALLER_EDGES.filter(edge => edge < maxEdge)]);
  } finally {
    // An ImageBitmap holds decoded pixels until it is closed; an <img> is
    // simply dropped.
    if (typeof source.close === 'function') {
      source.close();
    }
  }
};
