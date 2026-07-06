import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/** Encapsulates user profile data separate from Meteor account records. */
class ProfilesCollection {
  constructor() {
    this.name = 'ProfilesCollection';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      UH_ID: { type: SimpleSchema.Integer, optional: true },
      userId: { type: String, optional: true },
      email: { type: String, index: true, unique: true },
      firstName: { type: String, optional: true },
      lastName: { type: String, optional: true },
      bio: { type: String, optional: true },
      title: { type: String, optional: true },
      picture: { type: String, optional: true },
      interests: { type: Array, optional: true },
      'interests.$': String,
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const Profiles = new ProfilesCollection();
