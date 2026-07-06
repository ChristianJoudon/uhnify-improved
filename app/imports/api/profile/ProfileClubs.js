import { Mongo } from 'meteor/mongo';
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
    this.userPublicationName = `${this.name}.publication.user`;
    this.membershipPublicationName = `${this.name}.publication.memberships`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const ProfileClubs = new ProfileClubsCollection();
