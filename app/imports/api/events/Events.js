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
      /**
       * Who can find this event at all. Absent means public.
       *
       * The schema allows four values because the ingestion pipeline was
       * written against them, but the product now writes only 'public' and
       * 'private'. Anything other than absent or 'public' is treated as NOT
       * public everywhere a listing is shown, so 'members' and 'unlisted' on
       * an old record fail closed rather than open.
       */
      visibility: {
        type: String,
        allowedValues: ['public', 'members', 'private', 'unlisted'],
        optional: true,
      },
      /**
       * Nobody sees who is going — not other attendees, not friends, and not
       * the person who posted it. Counts only. See the same field on a group
       * for why the owner is included.
       *
       * This is the owner's own choice for the event. Whether the event is
       * anonymous in effect also depends on its host groups and on whether it
       * is sensitive: ask isAnonymousListing in
       * privacy/FriendActivityPrivacy.js, never this field alone.
       */
      anonymous: { type: Boolean, optional: true },
      /**
       * When this event last stopped being anonymous, if it ever was. Kept by
       * the server for the reason a group keeps its own: an RSVP made while
       * nobody could see it is not shown to friends because a switch moved
       * afterwards. See tookPartWhileAnonymous in
       * privacy/FriendActivityPrivacy.js.
       */
      anonymousUntil: { type: Date, optional: true },
      /**
       * How many people said Going, kept by the server on every swipe, undo
       * and removal. Stored for the same reason a group's memberCount is: an
       * anonymous event may show a number and nothing else. Recomputed from
       * the swipes by a startup migration.
       */
      goingCount: { type: SimpleSchema.Integer, min: 0, optional: true },
      /**
       * True while the event still follows its host group's privacy.
       *
       * An event made without privacy settings of its own copies its host's,
       * and keeps following them: when the group goes private or anonymous,
       * so does every event still marked here. The first time the owner sets
       * the event's privacy by hand this becomes false and the group stops
       * reaching into it — otherwise a later change to the group would
       * silently undo a decision somebody made on purpose.
       */
      privacyInherited: { type: Boolean, optional: true },
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
        // The public events publication sorts by date under a limit, for every
        // page anybody opens. Each index above leads with another key, so none
        // of them could serve it and the sort ran in memory over every event
        // that matched, inline photos and all.
        this.collection.rawCollection().createIndex({ date: 1 }).catch(error => {
          console.error('[index] Events date failed:', error.message);
        });
      });
    }
  }
}

export const Events = new EventsCollection();
