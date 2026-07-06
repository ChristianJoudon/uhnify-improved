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

const createOrUpdateUserProfile = (userId, email) => {
  const defaults = getProfileDefaults(email);
  const existingProfile = Profiles.collection.findOne({ $or: [{ userId }, { email }] });
  const profile = {
    UH_ID: defaults.UH_ID || existingProfile?.UH_ID || generateUH_ID(),
    userId,
    email,
    firstName: defaults.firstName || existingProfile?.firstName || '',
    lastName: defaults.lastName || existingProfile?.lastName || '',
    bio: defaults.bio || existingProfile?.bio || '',
    title: defaults.title || existingProfile?.title || 'Student',
    picture: defaults.picture || existingProfile?.picture || '/images/defaultprofilepic.png',
    interests: defaults.interests || existingProfile?.interests || [],
  };

  if (existingProfile) {
    Profiles.collection.update(existingProfile._id, { $set: profile });
    console.log(`  Profile updated for ${email}.`);
    return existingProfile._id;
  }

  const profileId = Profiles.collection.insert(profile);
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
