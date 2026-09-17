import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Roles } from 'meteor/alanning:roles';
import { Flags } from '../../api/moderation/Moderation';

/**
 * A banned account cannot sign in — by password, by a stored session, or by
 * any handler added later, because this runs for every one of them.
 * 'moderation.ban' also clears the stored tokens, which is what ends the
 * sessions that are open at that moment; this is what keeps them ended.
 */
Accounts.validateLoginAttempt(attempt => {
  if (attempt.user?.banned) {
    throw new Meteor.Error(403, 'This account has been suspended. Write to us if you think that is a mistake.');
  }
  return true;
});

/** The queue, for administrators only, capped like the audit trail is. */
Meteor.publish(Flags.openPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Flags.collection.find({ status: 'open' }, { sort: { createdAt: -1 }, limit: 200 });
  }
  return this.ready();
});

/** Which accounts are banned, so the admin's people list can say so. */
Meteor.publish('moderation.banned', function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Meteor.users.find({ banned: { $exists: true } }, { fields: { banned: 1, username: 1 } });
  }
  return this.ready();
});
