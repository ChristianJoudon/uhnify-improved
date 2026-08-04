import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
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

    /* Read from both ends — by club when drawing a group's page, by event when
       removing one — and written on every link. Neither direction was indexed. */
    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex({ clubId: 1, eventId: 1 }, { unique: true }).catch(error => {
          console.error('[index] EventClubs clubId+eventId failed; duplicate links are NOT prevented:', error.message);
        });
        this.collection.rawCollection().createIndex({ eventId: 1 }).catch(error => {
          console.error('[index] EventClubs eventId failed:', error.message);
        });
      });
    }
    this.userPublicationName = `${this.name}.publication.user`;
    this.linksPublicationName = `${this.name}.publication.links`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const EventClubs = new EventClubsCollection();
