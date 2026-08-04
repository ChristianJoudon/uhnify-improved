import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
/**
 * Registering the methods is this import's entire job, and it is load-bearing.
 *
 * `meteor test` does NOT run the app's entry points — server/main.js is never
 * loaded — so nothing pulls in Methods.js and `Meteor.server.method_handlers`
 * holds only the framework's own 46. Every test then fails with "No such
 * method", which looks like the harness is broken rather than like the app was
 * never loaded. Importing it here means any file that uses these fixtures gets
 * the methods registered by construction.
 */
import '../both/Methods';

/**
 * What every backend test needs before it can say anything.
 *
 * Two things make Meteor method testing awkward, and both are solved here once
 * rather than in forty test files.
 *
 * The first is identity. A method reads `this.userId`, which only exists inside
 * a real DDP call — so a test cannot simply import the method and call it.
 * `callAs` borrows the registered handler off `Meteor.server.method_handlers`
 * and applies it with a `this` that carries the userId we want. That is the
 * whole trick, and it is why these tests can assert on authorization at all:
 * calling as nobody, as the owner, and as a stranger are all one argument
 * apart.
 *
 * The second is isolation. These run under `meteor test`, which boots a
 * SEPARATE database from the development one, so nothing here can reach the
 * app's real data. Even so every suite wipes what it touches first: a test that
 * depends on what the last test left behind is a test that passes alone and
 * fails in a suite.
 */

/** Every collection a test may write, so `resetAll` cannot silently miss one. */
const COLLECTIONS = [Clubs, Events, EventClubs, EventSwipes, Friends, ProfileClubs, Profiles];

export const resetAll = () => {
  COLLECTIONS.forEach(entry => entry.collection.remove({}));
  Meteor.users.remove({});
};

/**
 * Invoke a method the way the server does, as a chosen user.
 *
 * `null` means signed out, which is a case worth testing on every method that
 * writes anything — "you must be logged in" is the guard most easily lost in a
 * refactor, and the one nobody notices is gone.
 */
export const callAs = (userId, name, ...args) => {
  const handler = Meteor.server.method_handlers[name];
  if (!handler) {
    throw new Error(`No such method: ${name}. Registered: ${Object.keys(Meteor.server.method_handlers).length}`);
  }
  return handler.apply({ userId, isSimulation: false, setUserId: () => {}, unblock: () => {}, connection: null }, args);
};

/** The error code a method threw, or null if it did not throw. Reads better in
    an assertion than a try/catch in every test. */
export const errorFrom = fn => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.error || error.message;
  }
};

let seq = 0;

/** A real account with a profile, which is what the app assumes everywhere. */
export const makeUser = ({ admin = false, email } = {}) => {
  seq += 1;
  const address = email || `person${seq}@test.example`;
  const userId = Accounts.createUser({ username: address, email: address, password: 'test-password' });
  Profiles.collection.insert({
    userId,
    email: address,
    firstName: `Person${seq}`,
    lastName: 'Test',
    interests: [],
  });
  if (admin) {
    Roles.createRole('admin', { unlessExists: true });
    Roles.addUsersToRoles(userId, 'admin');
  }
  return userId;
};

export const makeClub = (overrides = {}) => {
  seq += 1;
  return Clubs.collection.insert({
    clubID: 90000 + seq,
    name: `Test Club ${seq}`,
    // Required by the schema. Fixtures are deliberately minimal EXCEPT for
    // required fields — a fixture that quietly omits one turns every test in
    // the file into a validation error in a beforeEach, which reads as
    // "everything is broken" rather than "the fixture is wrong".
    owner: 'test-owner',
    description: 'A club that exists only for a test.',
    location: 'Līhuʻe',
    meetingTime: 'Mondays 5pm',
    categories: ['Other'],
    tags: [],
    ...overrides,
  });
};

export const makeEvent = (overrides = {}) => {
  seq += 1;
  return Events.collection.insert({
    eventID: 80000 + seq,
    title: `Test Event ${seq}`,
    description: 'An event that exists only for a test.',
    // Future-dated, because several publications and pages filter out the past
    // and a fixture that quietly falls off the end of them is a confusing test.
    date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    location: 'Līhuʻe',
    createdBy: 'test',
    ...overrides,
  });
};
