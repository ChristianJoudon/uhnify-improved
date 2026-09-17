import { Meteor } from 'meteor/meteor';
import { ListingPhotos } from './ListingPhotos';
import {
  PHOTO_KINDS,
  PHOTO_OWNER_ID,
  imageProblem,
  isPhotoPath,
  parsePhotoPath,
  photoPathFor,
  splitImageDataUrl,
} from '../listing/limits';

/**
 * Where an uploaded photo goes, and what its listing keeps instead.
 *
 * The forms still send a photo the way they always have: a data URL in the
 * listing's `image`, or the profile's `picture`. What changed is what is
 * stored. The bytes go to ListingPhotos, keyed by the kind of thing and the
 * _id of the document they belong to, and the document's field holds the path
 * they are served from. See ListingPhotos.js for what that saves.
 *
 * Everything that writes here is for the server, and every caller keeps it
 * there, as with friendActivitySync. A browser holds no photos; a method stub
 * checks the value (checkImage) and shows the person their own preview until
 * the server's answer replaces it.
 */

const IMAGE_PROBLEMS = {
  'invalid-image': 'Please choose a JPEG, PNG or WebP photo.',
  'image-too-large': 'That photo is too large — try a smaller one.',
};

const imageError = problem => new Meteor.Error(problem, IMAGE_PROBLEMS[problem]);

/**
 * Whether an error is this store saying no to a photo, as opposed to anything
 * else going wrong on the way to keeping one. The migration has to tell the
 * two apart — a refused photo is left where it is and that is the end of it,
 * a failed write is a fault somebody should hear about — and the list of what
 * counts as a refusal is the one above, not a second copy of it.
 */
export const isPhotoRefusal = error => error instanceof Meteor.Error
  && Object.prototype.hasOwnProperty.call(IMAGE_PROBLEMS, error.error);

/**
 * imageProblem reads an upload's first bytes and its length, and never the
 * rest. That was the whole job while the string was only ever handed back to
 * a browser. It is decoded on the server now, and Node's decoder does not
 * refuse what it does not recognise — it skips it. So a payload could carry
 * anything at all after its header, be stored as "a photo", and be served as
 * something shorter than what was kept. What is accepted is the base64
 * alphabet from the first character to the last, which is what every
 * browser's canvas and FileReader write.
 */
const WHOLE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isWholeBase64 = data => WHOLE_BASE64.test(data);

/**
 * A value that may be stored as an image, or the reason it may not, said to
 * the person who chose it. imageProblem decides; this puts words to it, and
 * reads an upload through to its end.
 *
 * It passes a photo path on its shape, so on the server it is the first check
 * and never the last: photoFieldFor is what asks whose photo the path names.
 */
export const checkImage = image => {
  const problem = imageProblem(image);
  if (problem) {
    throw imageError(problem);
  }
  const upload = splitImageDataUrl(image);
  if (upload && !isWholeBase64(upload.data)) {
    throw imageError('invalid-image');
  }
  return image;
};

/**
 * Nothing is kept under a key the route would not serve. Every _id the app
 * makes fits — Meteor's seventeen characters, the importer's thirty-two — so
 * this only ever stops a document somebody made by hand, and it stops it
 * here, out loud, rather than storing a photo that then answers 404 for ever.
 */
const isPhotoKey = (kind, ownerId) => PHOTO_KINDS.includes(kind)
  && typeof ownerId === 'string' && PHOTO_OWNER_ID.test(ownerId);

/**
 * Keep an uploaded photo, replacing the owner's last one, and say where it is
 * now served from.
 *
 * An upsert on (kind, ownerId), so there is one row per owner however many
 * times the photo is changed, and the old bytes are gone the moment the new
 * ones land. `updatedAt` moves with every save; it is the `v` in the path,
 * and so a replaced photo has a new address and nobody's cache shows the old.
 *
 * Checks for itself, whoever called: the migration comes here directly, with
 * rows that were stored under a check that looked at nothing but a prefix.
 */
export const savePhoto = ({ kind, ownerId, dataUrl }) => {
  checkImage(dataUrl);
  const upload = splitImageDataUrl(dataUrl);
  if (!upload || !isPhotoKey(kind, ownerId)) {
    throw imageError('invalid-image');
  }
  const updatedAt = new Date();
  ListingPhotos.collection.upsert({ kind, ownerId }, {
    $set: {
      contentType: upload.contentType,
      data: upload.data,
      // Decoded to be counted, by the decoder the route will use, so the
      // number stored is the number served and not an estimate of it.
      bytes: Buffer.from(upload.data, 'base64').length,
      updatedAt,
    },
  });
  return photoPathFor({ kind, ownerId, updatedAt });
};

/** Take an owner's photo down. How many rows went, which is one or none. */
export const removePhoto = ({ kind, ownerId }) => ListingPhotos.collection.remove({ kind, ownerId });

/**
 * What to store in a document's image field, given what the form sent — and,
 * on the way, whatever has to happen to the photo behind it. The ONE function
 * the methods call when a listing or a profile is edited, so that "what
 * happens to the old photo?" is answered in one place for all of them.
 *
 *   - '' or nothing: the person took the photo down, or never had one. Any
 *     stored photo goes, and the value comes back as it arrived, for the
 *     caller to do with it what it always did (an event falls back to the
 *     stock image; a group simply has none).
 *   - a data URL: a new upload. Checked, stored, and its path comes back.
 *   - a photo path naming THIS owner: the form was saved without touching the
 *     photo. Kept. When it is exactly what the document already holds
 *     (`previous`) that is the end of it and the database is not opened. When
 *     it is not — a second editor replaced the photo while this form was
 *     open — the path of the photo that is there now comes back, not the
 *     stale address the form was holding. No photo there at all reads as ''.
 *   - a photo path naming anybody else, or another kind: refused. The path is
 *     a string in a form, a form can be sent anything, and one listing must
 *     not be able to wear another's photo — least of all a private group's,
 *     whose photo address the sender could only have if they were let in.
 *   - one of the app's own images, or an https URL: stored as written, as
 *     before. The listing no longer shows an upload, so an upload it had goes.
 *
 * It removes without first asking whether there is anything to remove. One
 * delete on the unique index costs less than being wrong about it, and a row
 * orphaned by some write that went around the methods is cleared the next
 * time its listing is saved.
 */
export const photoFieldFor = ({ kind, ownerId, value, previous }) => {
  if (!value) {
    removePhoto({ kind, ownerId });
    return value;
  }
  checkImage(value);
  if (isPhotoPath(value)) {
    const named = parsePhotoPath(value);
    if (named.kind !== kind || named.ownerId !== ownerId) {
      throw imageError('invalid-image');
    }
    if (value === previous) {
      return value;
    }
    const stored = ListingPhotos.collection.findOne({ kind, ownerId }, { fields: { updatedAt: 1 } });
    return stored ? photoPathFor({ kind, ownerId, updatedAt: stored.updatedAt }) : '';
  }
  if (splitImageDataUrl(value)) {
    return savePhoto({ kind, ownerId, dataUrl: value });
  }
  removePhoto({ kind, ownerId });
  return value;
};

/**
 * Make a new listing, then give it its photo.
 *
 * A photo is keyed by its listing's _id, and a listing has none until it has
 * been inserted, so the order cannot be the obvious one. The record goes in
 * first WITHOUT its image — never with the data URL, not even for a moment:
 * every subscriber is sent an insert as it happens, and half a megabyte on the
 * wire is the thing this module exists to stop. Then the photo is stored under
 * the new _id and the path is set.
 *
 * If that second half fails, the listing is taken back out and the error goes
 * on to the person. A listing left standing without the photo its owner chose
 * would look like success, and they would find out from the wall.
 *
 * Everything that can be refused is refused BEFORE anything is inserted — a
 * link, a mislabelled file, a photo too large — so a refusal creates nothing
 * and uses up nothing. A photo path is refused there too, whatever it names: a
 * listing that does not exist yet has no photo of its own for a path to mean,
 * so every path is somebody else's. What is left for afterwards is the store
 * itself failing.
 *
 * Only an upload takes the two steps. Anything else — no image, the stock
 * one, an https link — has nothing to key and goes in with the record, as it
 * always did. So does everything in a browser: the stub keeps the value as
 * sent, which is the person's own preview, until the server's record arrives.
 */
export const insertWithPhoto = ({ kind, collection, field, record, value }) => {
  if (value) {
    checkImage(value);
  }
  if (isPhotoPath(value)) {
    throw imageError('invalid-image');
  }
  if (!Meteor.isServer || !splitImageDataUrl(value)) {
    return collection.insert({ ...record, [field]: value });
  }
  const ownerId = collection.insert(record);
  try {
    collection.update(ownerId, { $set: { [field]: savePhoto({ kind, ownerId, dataUrl: value }) } });
  } catch (error) {
    collection.remove(ownerId);
    removePhoto({ kind, ownerId });
    throw error;
  }
  return ownerId;
};
