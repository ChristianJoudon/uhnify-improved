import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';
import { listingFields } from '../listing/listingFields';

/* eslint-disable no-console */

/** The ClubsCollection. It encapsulates state and variable values for clubs. */
class ClubsCollection {
  constructor() {
    this.name = 'ClubsCollection';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      clubID: SimpleSchema.Integer,
      name: String,
      owner: String,
      description: { type: String, optional: true },
      location: String,
      image: { type: String, optional: true },
      meetingTime: String,
      publicationStatus: {
        type: String,
        allowedValues: ['draft', 'published', 'archived'],
        optional: true,
      },
      contactInfo: { type: String, optional: true },
      categories: {
        type: Array,
        optional: true,
      },
      'categories.$': String,
      // Member-added specific tags ("board games", "hiking", "K-pop") — power filters & recommendations.
      tags: {
        type: Array,
        optional: true,
      },
      'tags.$': String,
      // Recurring meeting schedule:
      //   { days: [0-6…], time: 'HH:mm', endTime?: 'HH:mm', cadence: 'weekly'|'biweekly'|'monthly', weeks?: [1|2|3|4|'last', …] }
      // `weeks` counts only when the cadence is monthly — "first and third
      // Thursday" is days [4], weeks [1, 3] — and a monthly schedule without
      // it is on no calendar, because nobody knows which week. A blackbox, so
      // nothing here checks it: every write goes through normalizeSchedule in
      // schedule.js, and every reader does too.
      schedule: {
        type: Object,
        optional: true,
        blackbox: true,
      },
      /** How to join or attend, in the organizer's own words. */
      membership: { type: String, optional: true },
      /**
       * Who can find this group at all.
       *
       * Absent means public, which is what every group made before this field
       * existed is, and what every imported listing stays. A private group is
       * left out of the directory, search and recommendations and is reached
       * only through its invite link. Code that decides what to show must
       * test for "absent or 'public'" rather than for "not 'private'", so a
       * value added later fails closed.
       */
      visibility: {
        type: String,
        allowedValues: ['public', 'private'],
        optional: true,
      },
      /**
       * Nobody sees who is in it — not other members, not friends, and not
       * the person who runs it. Counts only.
       *
       * It exists for recovery meetings and anything else where being seen on
       * a list is the reason someone stays home. The owner is included on
       * purpose: a roster the organizer can read is a roster that can be
       * subpoenaed, screenshotted or lost with a phone.
       *
       * This flag is the owner's choice. A sensitive listing is anonymous
       * whatever it says here; ask isAnonymousListing in
       * privacy/FriendActivityPrivacy.js, never this field alone.
       */
      anonymous: { type: Boolean, optional: true },
      /**
       * When this group last stopped being anonymous, if it ever was.
       *
       * Anonymity can be switched off, and "nobody sees who is in it, not
       * even the person who runs it" would mean nothing if switching it off
       * opened the list of everyone who joined while it was on. So the moment
       * it ends is kept, by the server, and the member list names only people
       * who joined after it. The rest stay a number. Friends are held to the
       * same line: a membership, or an RSVP to one of the group's events, is
       * shown to them only if it was made after this (tookPartWhileAnonymous
       * in privacy/FriendActivityPrivacy.js). Absent on a group that was
       * never anonymous, where there is no promise to keep.
       */
      anonymousUntil: { type: Date, optional: true },
      /** Left by a takedown — { takenDownAt, takenDownBy, reason } — so whoever
          posted it reads why it is down instead of finding it gone. */
      moderation: { type: Object, optional: true, blackbox: true },
      /** When an administrator last corrected an imported record in the app.
          The register sync leaves such a record alone. */
      curatedAt: { type: Date, optional: true },
      /**
       * Joining asks first: a request the owner approves or declines.
       *
       * Always false on an anonymous group. Approving a request means reading
       * a name, and an anonymous group promises that nobody does.
       */
      approveMembers: { type: Boolean, optional: true },
      /**
       * How many people are in it, kept by the server on every join and leave.
       *
       * Stored rather than counted on demand because an anonymous group may
       * publish a number and nothing else: there is no member list on the
       * client to take the length of. A startup migration recomputes it from
       * the memberships, so a drifted count heals on the next deploy.
       */
      memberCount: { type: SimpleSchema.Integer, min: 0, optional: true },
      /**
       * The secret in a private group's invite link.
       *
       * This is a capability: whoever holds it can join, with no further
       * question asked, because the owner handed it to them. It is therefore
       * never published to anyone but the owner and admins, never logged, and
       * replaced outright (not versioned) when the owner rotates it, so a
       * link that leaked stops working the moment they do.
       */
      inviteToken: { type: String, optional: true },
      ...listingFields,
      /**
       * When this was made and when it last changed.
       *
       * Both optional, because the register's imported records predate them
       * and a required field would reject every seeded document. Absent means
       * "from before we recorded it", which is honest; a backfilled guess
       * would not be.
       *
       * The audit trail says who changed what and when. These say it on the
       * document itself, which is what answers "is this listing stale?"
       * without a join.
       */
      createdAt: { type: Date, optional: true },
      updatedAt: { type: Date, optional: true },
    });
    this.collection.attachSchema(this.schema);

    /**
     * Opening an invite link looks a group up by its token, and that is the
     * only query in the app that does. Sparse, because nearly every group is
     * public and has none. Not unique: the tokens are 256 random bits, and a
     * constraint that can only ever fire by failing a legitimate write is not
     * worth having.
     */
    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex({ inviteToken: 1 }, { sparse: true }).catch(error => {
          console.error('[index] Clubs inviteToken failed; invite links will scan:', error.message);
        });
      });
    }

    this.userPublicationName = `${this.name}.publication.user`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const Clubs = new ClubsCollection();
