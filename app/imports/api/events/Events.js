import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';
import { listingFields } from '../listing/listingFields';

/* eslint-disable no-console */

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
      /**
       * Who posted it, by account name — which resolves to an email address.
       *
       * Optional, and no longer written by the app. On every record the app
       * ever made it duplicated `owner`, with one difference: the public
       * publications withheld `owner` and not this, so the copy nobody read
       * was the one every signed-out visitor received. The publications now
       * withhold both, and the startup migration in migrations.js clears the
       * redundant copies. The field stays declared because the ingestion
       * pipeline still stamps its system actor here; nothing reads it.
       */
      createdBy: { type: String, optional: true },
      owner: { type: String, optional: true },
      image: { type: String, optional: true },
      /** The end of the window, when the source gave one. */
      endDate: { type: Date, optional: true },
      /** Printed on the card so a listing can name its organizer. */
      hostName: { type: String, optional: true },
      categories: { type: Array, optional: true },
      'categories.$': String,
      /**
       * Canonical recommendation references. They are optional because older
       * imports and lightly described community events legitimately lack some
       * of them. Recommendation components must treat absence as unavailable,
       * never as a validation or ranking failure.
       */
      topicIds: { type: Array, optional: true },
      'topicIds.$': String,
      organizerId: { type: String, optional: true },
      venueId: { type: String, optional: true },
      seriesId: { type: String, optional: true },
      timeZone: { type: String, optional: true },
      /** GeoJSON Point: { type: 'Point', coordinates: [longitude, latitude] }. */
      geo: { type: Object, blackbox: true, optional: true },
      geoPrecision: {
        type: String,
        allowedValues: ['venue', 'address', 'town', 'region', 'unknown'],
        optional: true,
      },
      attendanceMode: {
        type: String,
        allowedValues: ['in_person', 'online', 'hybrid'],
        optional: true,
      },
      publicationStatus: {
        type: String,
        allowedValues: ['draft', 'published', 'archived'],
        optional: true,
      },
      cancellationStatus: {
        type: String,
        allowedValues: ['scheduled', 'canceled', 'postponed'],
        optional: true,
      },
      visibility: {
        type: String,
        allowedValues: ['public', 'members', 'private', 'unlisted'],
        optional: true,
      },
      capacity: { type: SimpleSchema.Integer, min: 0, optional: true },
      availabilityStatus: {
        type: String,
        allowedValues: ['available', 'limited', 'sold_out', 'waitlist', 'unknown'],
        optional: true,
      },
      minimumAge: { type: SimpleSchema.Integer, min: 0, optional: true },
      accessibility: { type: Object, blackbox: true, optional: true },
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

    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex({ geo: '2dsphere' }, { sparse: true }).catch(error => {
          console.error('[index] Events geo failed:', error.message);
        });
        this.collection.rawCollection().createIndex({ topicIds: 1, date: 1 }).catch(error => {
          console.error('[index] Events topicIds+date failed:', error.message);
        });
        this.collection.rawCollection().createIndex({ organizerId: 1, date: 1 }).catch(error => {
          console.error('[index] Events organizerId+date failed:', error.message);
        });
        this.collection.rawCollection().createIndex({ seriesId: 1, date: 1 }).catch(error => {
          console.error('[index] Events seriesId+date failed:', error.message);
        });
      });
    }
  }
}

export const Events = new EventsCollection();
