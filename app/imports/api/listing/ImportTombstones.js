import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/* eslint-disable no-console */

/**
 * What an administrator removed on purpose, so a refresh does not put it back.
 *
 * The register sync (tools/sync-register.mjs) upserts every record it holds on
 * the publisher's stable id. That is what makes it re-runnable — and it meant
 * that a listing an administrator had deleted came back with the next refresh,
 * every time, for as long as the register still carried it. A deletion is a
 * decision; this is where the decision is kept. Server-only, never published.
 */
export const ImportTombstones = {
  name: 'ImportTombstones',
  collection: new Mongo.Collection('ImportTombstones'),
};

ImportTombstones.collection.attachSchema(new SimpleSchema({
  importedFrom: String,
  sourceId: String,
  kind: { type: String, allowedValues: ['event', 'club'] },
  removedAt: Date,
  removedBy: { type: String, optional: true },
}));

if (Meteor.isServer) {
  Meteor.startup(() => {
    ImportTombstones.collection.rawCollection().createIndex({ importedFrom: 1, sourceId: 1 }, { unique: true })
      .catch(error => console.error('[index] ImportTombstones failed:', error.message));
  });
}

/** Remember that this imported record was removed on purpose. No-op for anything
    the app itself created — those have no sourceId, and no refresh recreates them. */
export const buryImported = (kind, record, removedBy) => {
  if (!Meteor.isServer || !record?.importedFrom || !record?.sourceId) {
    return;
  }
  ImportTombstones.collection.upsert(
    { importedFrom: record.importedFrom, sourceId: record.sourceId },
    { $set: { kind, removedAt: new Date(), removedBy } },
  );
};
