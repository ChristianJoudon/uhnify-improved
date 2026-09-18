import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Accounts } from 'meteor/accounts-base';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { Profiles } from '../profiles/Profiles';
import { ProfileClubs } from '../profile/ProfileClubs';
import { EventSwipes } from '../events/EventSwipes';
import { Friends } from '../friends/Friends';
import { ClubJoinRequests } from '../club/ClubJoinRequests';
import { AuditLog } from '../audit/AuditLog';
import { Flags, ClubBlocks } from '../moderation/Moderation';
import { accountNameOf } from '../listing/ownership';
import {
  EventAttendances,
  EventRSVPs,
  RecommendationGraphEdges,
  RecommendationImpressions,
  RecommendationInteractions,
  RecommendationPreferences,
  RecommendationRequests,
  UserItemStates,
} from '../recommendations/RecommendationData';

const requireLoggedIn = userId => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'Sign in first.');
  }
};

/**
 * Everything that is about ONE person, taken away when they ask.
 *
 * Their memberships, plans, friendships, requests, reports, the trail the
 * recommender kept of them, their profile and its photo, and the account. What
 * they posted for everyone else — a group, an event — stays up for everyone
 * else, with the account name taken off it and any contact address they had
 * chosen to print removed; an administrator runs it from there. The audit trail
 * keeps its rows (a takedown they were given has to stay explicable) but loses
 * the address that named them.
 */
export const eraseAccount = userId => {
  const owner = accountNameOf(userId);
  ProfileClubs.collection.remove({ userId });
  EventSwipes.collection.remove({ userId });
  Friends.collection.remove({ $or: [{ requesterId: userId }, { receiverId: userId }] });
  ClubJoinRequests.collection.remove({ userId });
  ClubBlocks.collection.remove({ userId });
  Flags.collection.update({ reporterId: userId }, { $set: { reporterId: 'deleted' } }, { multi: true });
  [
    RecommendationInteractions, RecommendationImpressions, UserItemStates, RecommendationRequests,
    RecommendationPreferences, EventRSVPs, EventAttendances,
  ].forEach(entry => entry.collection.remove({ userId }));
  RecommendationGraphEdges.collection.remove({ $or: [{ fromType: 'user', fromId: userId }, { toType: 'user', toId: userId }] });
  if (owner) {
    // A group's owner is required by its schema; 'deleted-account' is a name
    // no account can have (no @), so nobody inherits the group by signing up.
    Clubs.collection.update({ owner }, { $set: { owner: 'deleted-account' } }, { multi: true });
    Events.collection.update({ owner }, { $unset: { owner: '', email: '' } }, { multi: true });
  }
  AuditLog.collection.update({ actorId: userId }, { $unset: { actorEmail: '' }, $set: { actorId: 'deleted' } }, { multi: true });
  Profiles.collection.remove({ userId });
  Meteor.users.remove(userId);
};

Meteor.methods({
  /** The verification mail again, for somebody who lost the first one. */
  'accounts.resendVerification'() {
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return null;
    }
    const user = Meteor.users.findOne(this.userId, { fields: { emails: 1 } });
    const pending = (user?.emails || []).find(entry => !entry.verified);
    if (!pending) {
      return 'verified';
    }
    Accounts.sendVerificationEmail(this.userId, pending.address);
    return 'sent';
  },

  /**
   * Delete my account. Confirmed with the password, hashed in the browser the
   * way sign-in hashes it, so a tab left open on a shared phone cannot do this
   * with one tap. An administrator cannot delete their own account this way
   * while they are the last one: somebody has to be able to run the place.
   */
  'accounts.deleteMine'(password) {
    check(password, { digest: String, algorithm: String });
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return null;
    }
    const user = Meteor.users.findOne(this.userId);
    const checked = Accounts._checkPassword(user, password);
    if (checked.error) {
      throw new Meteor.Error('wrong-password', 'That is not your password.');
    }
    if (Roles.userIsInRole(this.userId, 'admin') && Roles.getUsersInRole('admin').count() <= 1) {
      throw new Meteor.Error('last-administrator', 'You are the only administrator. Make somebody else one first.');
    }
    eraseAccount(this.userId);
    return true;
  },
});
