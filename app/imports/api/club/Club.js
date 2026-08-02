import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';
import { listingFields } from '../listing/listingFields';

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
      // Recurring meeting schedule: { days: [0-6], time: 'HH:mm', cadence: 'weekly'|'biweekly' }.
      schedule: {
        type: Object,
        optional: true,
        blackbox: true,
      },
      /** How to join or attend, in the organizer's own words. */
      membership: { type: String, optional: true },
      ...listingFields,
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const Clubs = new ClubsCollection();
