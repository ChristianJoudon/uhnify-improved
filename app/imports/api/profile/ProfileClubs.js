import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
import SimpleSchema from 'simpl-schema';
import { FRIEND_ACTIVITY_VISIBILITY } from '../privacy/FriendActivityPrivacy';

/** Stores the clubs each user has joined. */
class ProfileClubsCollection {
  constructor() {
    this.name = 'ProfileClubs';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      userId: String,
      clubId: String,
      friendActivityVisibility: {
        type: String,
        allowedValues: Object.values(FRIEND_ACTIVITY_VISIBILITY),
        optional: true,
        defaultValue: FRIEND_ACTIVITY_VISIBILITY.private,
      },
      createdAt: { type: Date, optional: true },
      /**
       * This person joined while the group was anonymous, and so may be shown
       * to the person who runs it under their made-up name.
       *
       * It is a fact about the JOIN, written once by joinClub and never moved
       * afterwards. 'clubs.members' first gave a made-up row to everybody in
       * a group that is anonymous NOW — so an owner could read a named list,
       * switch anonymity on, read the list again, and hold each person's name
       * beside the made-up one they carry into every other anonymous group.
       * The dates the group keeps cannot stand in for this: `anonymousUntil`
       * is the last time anonymity ended, and says nothing of when it began
       * or of a second time round.
       *
       * Absent means "not known to have", which is read as no. A membership
       * from before the flag existed is shown under no made-up name at all.
       */
      joinedAnonymous: { type: Boolean, optional: true },
    });
    this.collection.attachSchema(this.schema);

    /**
     * Every per-user subscription in the app reads this collection by userId,
     * and several publications do it twice on one page — with no index that is
     * a full scan each time, growing with every membership anyone anywhere
     * creates.
     *
     * The pair is unique because a person is either in a group or not; there is
     * no such thing as being in it twice. The methods already guard duplicates
     * with find-then-insert, which two concurrent calls both pass, so this is
     * the constraint that actually holds the line rather than merely the one
     * that makes the query fast.
     */
    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex({ userId: 1, clubId: 1 }, { unique: true }).catch(error => {
          console.error('[index] ProfileClubs userId+clubId failed; duplicates are NOT prevented:', error.message);
        });
      });
    }

    this.userPublicationName = `${this.name}.publication.user`;
    this.membershipPublicationName = `${this.name}.publication.memberships`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const ProfileClubs = new ProfileClubsCollection();
