import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

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
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const Events = new EventsCollection();
