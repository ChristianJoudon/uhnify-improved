import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/* eslint-disable no-console */

/**
 * What people tell us is wrong, and who a group has shut its door on.
 *
 * Anyone can post here — that was decided — and there is no captcha and never
 * will be. What stands in for both is this: any signed-in person can flag a
 * listing, an administrator reads the queue and can take the listing down, and
 * an account that keeps doing it can be banned. Neither collection is ever
 * published to anyone but an administrator; a block is not shown to the person
 * it names.
 */

export const FLAG_REASONS = Object.freeze([
  { value: 'wrong-info', label: 'The details are wrong' },
  { value: 'not-real', label: 'It is not a real listing' },
  { value: 'unsafe', label: 'It is unsafe or hateful' },
  { value: 'spam', label: 'It is spam or an advert' },
  { value: 'other', label: 'Something else' },
]);

export const FLAG_NOTE_MAX = 500;

export const Flags = {
  name: 'ModerationFlags',
  collection: new Mongo.Collection('ModerationFlags'),
  openPublicationName: 'moderation.flags.open',
};

Flags.collection.attachSchema(new SimpleSchema({
  kind: { type: String, allowedValues: ['event', 'club'] },
  listingId: String,
  /** Kept so a takedown can be explained after the listing is gone. */
  listingTitle: { type: String, optional: true },
  reporterId: String,
  reason: { type: String, allowedValues: FLAG_REASONS.map(reason => reason.value) },
  note: { type: String, optional: true, max: FLAG_NOTE_MAX },
  status: { type: String, allowedValues: ['open', 'resolved'] },
  resolution: { type: String, allowedValues: ['dismissed', 'taken-down'], optional: true },
  createdAt: Date,
  resolvedAt: { type: Date, optional: true },
  resolvedBy: { type: String, optional: true },
}));

/** A group's shut door. Keyed by account, shown to its owner under whatever
    name the group shows its members by — a made-up one, if it is anonymous. */
export const ClubBlocks = {
  name: 'ClubBlocks',
  collection: new Mongo.Collection('ClubBlocks'),
};

ClubBlocks.collection.attachSchema(new SimpleSchema({
  clubId: String,
  userId: String,
  createdAt: Date,
  createdBy: String,
}));

if (Meteor.isServer) {
  Meteor.startup(() => {
    // One flag per person per listing: a queue of forty flags from one account
    // is one opinion, and the index is what makes it count as one.
    Flags.collection.rawCollection().createIndex({ listingId: 1, reporterId: 1 }, { unique: true })
      .catch(error => console.error('[index] ModerationFlags listingId+reporterId failed:', error.message));
    Flags.collection.rawCollection().createIndex({ status: 1, createdAt: -1 })
      .catch(error => console.error('[index] ModerationFlags status failed:', error.message));
    ClubBlocks.collection.rawCollection().createIndex({ clubId: 1, userId: 1 }, { unique: true })
      .catch(error => console.error('[index] ClubBlocks clubId+userId failed:', error.message));
  });
}

/** Whether this group has shut its door on this person. Server-side truth; a
    browser holds no blocks and is told nothing. */
export const isBlockedFrom = (userId, clubIds) => Boolean(userId) && clubIds.length > 0
  && ClubBlocks.collection.find({ userId, clubId: { $in: clubIds } }, { limit: 1 }).count() > 0;
