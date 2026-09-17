import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/* eslint-disable no-console */

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'declined'];

/**
 * How long a "no" lasts. A declined request cannot be sent again until this
 * much time has passed since the owner answered it.
 *
 * Without a wait, declining does nothing: the person asks again and the owner
 * is looking at the same name a minute later, as often as the requester cares
 * to press the button. Blocking somebody outright is a later phase; this is
 * the floor under it. It is not forever, because people and groups both
 * change, and a refusal nobody can ever revisit is a ban by another name.
 */
export const JOIN_REQUEST_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Somebody asking to join a group whose owner approves members.
 *
 * A request names a person to the owner, which is exactly what an anonymous
 * group promises never to do — so anonymous groups never have requests, and
 * the methods that write here refuse to make one for them.
 */
class ClubJoinRequestsCollection {
  constructor() {
    this.name = 'ClubJoinRequests';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      /** The group's Mongo _id, as a membership stores it. */
      clubId: String,
      /** Who is asking. */
      userId: String,
      status: { type: String, allowedValues: JOIN_REQUEST_STATUSES },
      createdAt: Date,
      /** When the owner answered, which is what the re-request wait counts from. */
      respondedAt: { type: Date, optional: true },
      /** The userId that answered: the owner or an admin. Never shown to the requester. */
      respondedBy: { type: String, optional: true },
    });
    this.collection.attachSchema(this.schema);

    /**
     * One request per person per group. A second ask reuses the row rather
     * than adding one, so the owner's list cannot be flooded by one person
     * and "is there already a request?" has a single answer. As with
     * memberships, the find-then-insert in the method is passed by two
     * concurrent calls; this index is what actually holds.
     */
    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex({ clubId: 1, userId: 1 }, { unique: true }).catch(error => {
          console.error('[index] ClubJoinRequests clubId+userId failed; duplicates are NOT prevented:', error.message);
        });
      });
    }

    this.minePublicationName = `${this.name}.publication.mine`;
    this.ownerPublicationName = `${this.name}.publication.forOwner`;
  }
}

export const ClubJoinRequests = new ClubJoinRequestsCollection();
