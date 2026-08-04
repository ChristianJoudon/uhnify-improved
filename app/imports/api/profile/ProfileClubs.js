import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
import SimpleSchema from 'simpl-schema';

/** Stores the clubs each user has joined. */
class ProfileClubsCollection {
  constructor() {
    this.name = 'ProfileClubs';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      userId: String,
      clubId: String,
      createdAt: { type: Date, optional: true },
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
