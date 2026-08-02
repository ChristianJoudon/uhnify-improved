import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/**
 * Each user's deck decision. The deck swipes events and, in its clubs mode,
 * groups — one collection rather than two, because a decision is a decision and
 * the unique index below already keys on the record id, which is distinct
 * across collections. `kind` says which collection to look the id up in.
 */
class EventSwipesCollection {
  constructor() {
    this.name = 'EventSwipes';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      userId: String,
      eventId: String,
      decision: { type: String, allowedValues: ['interested', 'passed'] },
      kind: { type: String, allowedValues: ['event', 'club'], optional: true, defaultValue: 'event' },
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
