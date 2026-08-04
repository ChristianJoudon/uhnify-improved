import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Roles } from 'meteor/alanning:roles';
import { Profiles } from '../../api/profiles/Profiles';

/* eslint-disable no-console */

const generateUH_ID = () => {
  const min = 22400000;
  const max = 22499999;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const getProfileDefaults = email => Meteor.settings.defaultProfiles?.find(profile => profile.email === email) || {};

/**
 * Make sure this account has a profile. Create one if it has none; otherwise
 * leave what is there alone.
 *
 * The order used to be `defaults.field || existing.field`, which reads as
 * "prefer a default" — and for the demo accounts in settings.json a default
 * always exists, so it always won. Since the block at the bottom of this file
 * runs for every user on every boot, restarting the dev server reverted the
 * signed-in account's name, title, bio, photo and interests to the seed. The
 * edits had saved; a restart took them back, which is a far more confusing
 * failure than never saving at all.
 *
 * A default is what to use when there is nothing. It is not a correction.
 */
const createOrUpdateUserProfile = (userId, email) => {
  const defaults = getProfileDefaults(email);
  const existingProfile = Profiles.collection.findOne({ $or: [{ userId }, { email }] });

  if (existingProfile) {
    // The account link is the one field the profile does not own: a reset users
    // collection issues new _ids, and a profile pointing at a stale one belongs
    // to nobody.
    if (existingProfile.userId !== userId) {
      Profiles.collection.update(existingProfile._id, { $set: { userId } });
    }
    return existingProfile._id;
  }

  const profileId = Profiles.collection.insert({
    UH_ID: defaults.UH_ID || generateUH_ID(),
    userId,
    email,
    firstName: defaults.firstName || '',
    lastName: defaults.lastName || '',
    bio: defaults.bio || '',
    title: defaults.title || 'Student',
    picture: defaults.picture || '/images/defaultprofilepic.png',
    interests: defaults.interests || [],
  });
  console.log(`  Profile created for ${email}.`);
  return profileId;
};

const createUser = ({ email, password, role }) => {
  console.log(`  Creating user ${email}.`);
  const userID = Accounts.createUser({ username: email, email, password });
  createOrUpdateUserProfile(userID, email);

  if (role === 'admin') {
    Roles.createRole(role, { unlessExists: true });
    Roles.addUsersToRoles(userID, 'admin');
  }
};

if (Meteor.users.find().count() === 0) {
  if (Meteor.settings.defaultAccounts) {
    console.log('Creating the default user(s)');
    Meteor.settings.defaultAccounts.forEach(account => createUser(account));
  } else {
    console.log('Cannot initialize default accounts. Please invoke Meteor with a settings file.');
  }
} else {
  Meteor.users.find().forEach(user => {
    const email = user.username || user.emails?.[0]?.address;
    if (email) {
      createOrUpdateUserProfile(user._id, email);
    }
  });
}
