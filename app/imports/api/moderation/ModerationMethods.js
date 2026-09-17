import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { accountNameOf } from '../listing/ownership';
import { PUBLISHED_SELECTOR } from '../listing/audience';
import { FLAG_NOTE_MAX, FLAG_REASONS, Flags } from './Moderation';

const collectionFor = kind => (kind === 'club' ? Clubs.collection : Events.collection);

const requireAdmin = userId => {
  if (!userId || !Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'Only an administrator can do that.');
  }
};

const checkKind = kind => {
  if (!['event', 'club'].includes(kind)) {
    throw new Meteor.Error('invalid-kind', 'A listing is either an event or a group.');
  }
};

/**
 * Take a listing off every wall, and say why on the listing itself.
 *
 * 'archived' is already what the public selector refuses, so nothing else has
 * to learn a new state. The note rides on the record so the person who posted
 * it — who still receives it through the owned publication — reads a reason
 * rather than finding it gone.
 */
export const takeDown = (kind, listingId, { by, reason }) => collectionFor(kind).update(listingId, {
  $set: {
    publicationStatus: 'archived',
    moderation: { takenDownAt: new Date(), takenDownBy: by, reason },
  },
});

Meteor.methods({
  'moderation.flag'(kind, listingId, reason, note = '') {
    check(kind, String);
    checkKind(kind);
    check(listingId, String);
    check(reason, String);
    check(note, String);
    if (!this.userId) {
      throw new Meteor.Error('not-logged-in', 'Sign in to report a listing.');
    }
    if (!FLAG_REASONS.some(known => known.value === reason)) {
      throw new Meteor.Error('invalid-reason', 'Pick what is wrong with it.');
    }
    const words = note.trim();
    if (words.length > FLAG_NOTE_MAX) {
      throw new Meteor.Error('too-long', `A note is limited to ${FLAG_NOTE_MAX} characters.`);
    }
    if (!Meteor.isServer) {
      return null;
    }
    const listing = collectionFor(kind).findOne(
      { $and: [{ _id: listingId }, PUBLISHED_SELECTOR] },
      { fields: { title: 1, name: 1 } },
    );
    if (!listing) {
      throw new Meteor.Error('not-found', 'That listing is not up any more.');
    }
    // Said twice is said once: the second report from the same person updates
    // the first rather than being refused, so they are never told "you
    // already did that" for trying to add what they forgot.
    const existing = Flags.collection.findOne({ listingId, reporterId: this.userId });
    if (existing) {
      Flags.collection.update(existing._id, {
        $set: { reason, note: words, status: 'open', createdAt: new Date() },
        $unset: { resolution: '', resolvedAt: '', resolvedBy: '' },
      });
      return existing._id;
    }
    return Flags.collection.insert({
      kind,
      listingId,
      listingTitle: listing.title || listing.name,
      reporterId: this.userId,
      reason,
      note: words,
      status: 'open',
      createdAt: new Date(),
    });
  },

  'moderation.resolveFlag'(flagId, action, reason = '') {
    check(flagId, String);
    check(action, String);
    check(reason, String);
    requireAdmin(this.userId);
    if (!['dismiss', 'takedown'].includes(action)) {
      throw new Meteor.Error('invalid-action', 'A flag is either dismissed or acted on.');
    }
    const flag = Flags.collection.findOne(flagId);
    if (!flag) {
      throw new Meteor.Error('not-found', 'That flag is gone.');
    }
    const resolved = { status: 'resolved', resolvedAt: new Date(), resolvedBy: this.userId };
    if (action === 'dismiss') {
      Flags.collection.update(flagId, { $set: { ...resolved, resolution: 'dismissed' } });
      return 'dismissed';
    }
    takeDown(flag.kind, flag.listingId, {
      by: this.userId,
      reason: reason.trim().slice(0, FLAG_NOTE_MAX) || FLAG_REASONS.find(known => known.value === flag.reason).label,
    });
    // Everyone who flagged it is answered at once, not one click each.
    Flags.collection.update(
      { listingId: flag.listingId, status: 'open' },
      { $set: { ...resolved, resolution: 'taken-down' } },
      { multi: true },
    );
    return 'taken-down';
  },

  'moderation.takeDown'(kind, listingId, reason) {
    check(kind, String);
    checkKind(kind);
    check(listingId, String);
    check(reason, String);
    requireAdmin(this.userId);
    if (!reason.trim()) {
      throw new Meteor.Error('required', 'Say why, so the person who posted it can read it.');
    }
    return takeDown(kind, listingId, { by: this.userId, reason: reason.trim().slice(0, FLAG_NOTE_MAX) });
  },

  'moderation.restore'(kind, listingId) {
    check(kind, String);
    checkKind(kind);
    check(listingId, String);
    requireAdmin(this.userId);
    return collectionFor(kind).update(listingId, {
      $set: { publicationStatus: 'published' },
      $unset: { moderation: '' },
    });
  },

  /**
   * Ban an account: it cannot sign in, every open session ends now, and what
   * it posted comes down with a reason on it. Undone by 'moderation.unban',
   * which does NOT put the listings back — that is a decision per listing.
   */
  'moderation.ban'(userId, reason) {
    check(userId, String);
    check(reason, String);
    requireAdmin(this.userId);
    if (userId === this.userId) {
      throw new Meteor.Error('not-allowed', 'You cannot ban yourself.');
    }
    if (Roles.userIsInRole(userId, 'admin')) {
      throw new Meteor.Error('not-allowed', 'An administrator cannot be banned. Remove the role first.');
    }
    const why = reason.trim().slice(0, FLAG_NOTE_MAX);
    if (!why) {
      throw new Meteor.Error('required', 'Say why. It is the only record of the decision.');
    }
    if (!Meteor.isServer) {
      return null;
    }
    const owner = accountNameOf(userId);
    const updated = Meteor.users.update(userId, {
      $set: {
        banned: { at: new Date(), by: this.userId, reason: why },
        // Removing the tokens is what ends the sessions already open; refusing
        // the next login (see startup/server/bans.js) only stops new ones.
        'services.resume.loginTokens': [],
      },
    });
    if (!updated) {
      throw new Meteor.Error('not-found', 'That account does not exist.');
    }
    if (owner) {
      const theirs = { owner, importedFrom: { $exists: false }, publicationStatus: { $ne: 'archived' } };
      const note = { takenDownAt: new Date(), takenDownBy: this.userId, reason: 'The account that posted this was suspended.' };
      [Clubs.collection, Events.collection].forEach(collection => collection.update(
        theirs,
        { $set: { publicationStatus: 'archived', moderation: note } },
        { multi: true },
      ));
    }
    return true;
  },

  'moderation.unban'(userId) {
    check(userId, Match.OneOf(String));
    requireAdmin(this.userId);
    return Meteor.users.update(userId, { $unset: { banned: '' } });
  },
});
