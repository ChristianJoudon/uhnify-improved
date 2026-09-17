import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';
import { IMAGE_DATA_URL_MAX, PHOTO_KINDS } from '../listing/limits';

/* eslint-disable no-console */

/** The three formats the app accepts, which are the only three it serves. */
export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The photos people upload, one row per listing or profile that has one.
 *
 * A photo used to live on the document it illustrates, as a data URL of up to
 * 700,000 characters in `image` or `picture`. A publication sends whole
 * documents, so that half-megabyte went down the websocket to every visitor
 * with every card — scrolled to or not — and again on the next visit, because
 * nothing that arrives over DDP is something a browser can cache. The people
 * directory did the same with every member's avatar, to every signed-in user.
 *
 * Here the bytes are out of the documents' way. The document keeps a short
 * path, `/photo/<kind>/<ownerId>?v=<updatedAt>`, and the browser fetches that
 * like any other image: once, only for a card it actually draws, and then
 * from its own cache (see startup/server/photoRoute.js).
 *
 * This collection is NEVER published and has no methods of its own. The only
 * writer is api/photos/photoStore.js and the only reader is the route. The
 * module is reachable from the browser bundle, because Methods.js runs on both
 * sides and imports the store, but all that gives a browser is an empty local
 * collection that nothing fills.
 */
class ListingPhotosCollection {
  constructor() {
    this.name = 'ListingPhotos';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      /** Which collection the owner is in. */
      kind: { type: String, allowedValues: PHOTO_KINDS },
      /** The _id of the event, group or profile whose photo this is. */
      ownerId: String,
      /** What the first bytes were checked against when it was stored. The
          route still refuses to send anything but these three, so a row edited
          by hand cannot make the app serve a page. */
      contentType: { type: String, allowedValues: PHOTO_CONTENT_TYPES },
      /** The base64 payload alone, without the `data:…;base64,` in front. */
      data: { type: String, max: IMAGE_DATA_URL_MAX },
      /** The decoded size, which is the Content-Length it is served with. */
      bytes: SimpleSchema.Integer,
      /** When this photo was last replaced — the `v` in its path. */
      updatedAt: Date,
    });
    this.collection.attachSchema(this.schema);

    /**
     * One photo per owner, and the index the route's every lookup uses. The
     * store writes with an upsert on exactly this pair, so a replaced photo
     * overwrites its row rather than leaving the old half-megabyte beside it.
     */
    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex({ kind: 1, ownerId: 1 }, { unique: true }).catch(error => {
          console.error('[index] ListingPhotos kind+ownerId failed; photo lookups will scan:', error.message);
        });
      });
    }
  }
}

export const ListingPhotos = new ListingPhotosCollection();
