import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/** Stores optional event-to-club links for future expansion. */
class EventClubsCollection {
  constructor() {
    this.name = 'EventClubs';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      userId: { type: String, optional: true },
      eventId: String,
      clubId: String,
      createdAt: { type: Date, optional: true },
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    this.linksPublicationName = `${this.name}.publication.links`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const EventClubs = new EventClubsCollection();
