import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';
import { listingFields } from '../listing/listingFields';

/** The EventsCollection. It encapsulates state and variable values for events. */
class EventsCollection {
  constructor() {
    this.name = 'EventsCollection';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      // This field represents the numeric host club ID used throughout the original project.
      eventID: SimpleSchema.Integer,
      title: String,
      description: {
        type: String,
        optional: true,
      },
      date: Date,
      location: String,
      createdBy: String,
      owner: { type: String, optional: true },
      image: { type: String, optional: true },
      /** The end of the window, when the source gave one. */
      endDate: { type: Date, optional: true },
      /** Printed on the card so a listing can name its organizer. */
      hostName: { type: String, optional: true },
      categories: { type: Array, optional: true },
      'categories.$': String,
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
    this.userPublicationName = `${this.name}.publication.user`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const Events = new EventsCollection();
