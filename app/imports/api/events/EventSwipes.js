import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/** Stores each user's Discover deck decision (interested or passed) for an event. */
class EventSwipesCollection {
  constructor() {
    this.name = 'EventSwipes';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      userId: String,
      eventId: String,
      decision: { type: String, allowedValues: ['interested', 'passed'] },
      createdAt: { type: Date, optional: true },
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    if (Meteor.isServer) {
      Meteor.startup(() => {
        // One decision per user per event, enforced at the database level so the
        // find-then-insert in eventSwipes.record cannot race into duplicates.
        this.collection.rawCollection().createIndex({ userId: 1, eventId: 1 }, { unique: true }).catch(() => {});
      });
    }
  }
}

export const EventSwipes = new EventSwipesCollection();
