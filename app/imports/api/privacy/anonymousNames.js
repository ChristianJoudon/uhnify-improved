/* global Npm */
import { Meteor } from 'meteor/meteor';
import moment from 'moment-timezone';
import { LISTING_TIME_ZONE } from '../listing/audience';
import { ANONYMOUS_NAME_INDEX, Profiles } from '../profiles/Profiles';
import { isDuplicateKey, serverSecret } from './ServerSecrets';

/* eslint-disable no-console */

/**
 * Made-up names for the people in anonymous groups: "Sleepy Honu", "Bold
 * Rooster", "Quiet Gecko".
 *
 * An anonymous group used to show the person who runs it a number and nothing
 * else. That kept every promise and left them unable to tell three regulars
 * from thirty strangers, or to ask one person to stop coming. So each person
 * has ONE made-up name, the same in every anonymous group, for good — enough
 * to be somebody, and nothing that says who.
 *
 * The name is worked out from the account's id, and everything rests on HOW.
 *
 * It is a KEYED hash, never a plain one. The people directory sends every
 * profile's userId to every signed-in user, and the two lists of words below
 * sit in a public repository. With a plain hash, anyone could run the whole
 * directory through this file and have everybody's name by lunchtime — the
 * anonymity undone by the thing built to serve it. HMAC-SHA256 with a secret
 * that never leaves the server means the lists and the ids together give
 * nothing. The secret is made on first need and kept in ServerSecrets, so
 * there is nothing to configure and nothing to lose;
 * Meteor.settings.anonymousNames.secret, when somebody has set one, wins.
 *
 * It hashes the userId and not the email, because a name has to survive a
 * change of address.
 *
 * And the answer is STORED, on the profile, the first time it is needed,
 * rather than worked out on each asking. Two reasons. A few thousand names
 * shared among a few hundred people collide often, and "unique" is a promise
 * only a database index can keep: when a name is taken the hash is asked
 * again with a counter in it, until a free one turns up. And a stored name
 * does not move when the secret does, so replacing the secret renames nobody.
 *
 * Who is shown a name is decided by the callers, and the list is short; see
 * `anonymousName` in Profiles.js. Nothing in this file writes a name to a
 * log, and nothing that calls it may: a log line holding a name beside an
 * account is the mapping this exists to keep from everybody but an
 * administrator.
 *
 * Everything here that reads the secret is for the server, and every caller
 * keeps it there. Methods.js is loaded by the browser too, for its stubs, and
 * imports this file — which is why Node's crypto is asked for below in a way
 * the bundler cannot see. A plain `import` would have it ship the browser a
 * half-megabyte polyfill for code that never runs there.
 */
const crypto = Meteor.isServer ? Npm.require('crypto') : null;

/**
 * Gentle and silly, and never unkind. These names turn up in recovery
 * meetings, grief circles and clinics, so nothing here remarks on a body, a
 * mood that might be a symptom, an appetite or a drink — no 'Hungry', no
 * 'Dizzy', no 'Tipsy' — and not 'Patient', which is a fine virtue and a worse
 * thing to be called in a waiting room.
 */
export const ADJECTIVES = Object.freeze([
  'Sleepy', 'Bold', 'Quiet', 'Salty', 'Sunny', 'Breezy', 'Mellow', 'Jolly',
  'Cheery', 'Dapper', 'Gentle', 'Brave', 'Curious', 'Nimble', 'Plucky', 'Snug',
  'Sandy', 'Misty', 'Rosy', 'Peppy', 'Zesty', 'Bouncy', 'Chipper', 'Cozy',
  'Dreamy', 'Fuzzy', 'Happy', 'Humble', 'Jazzy', 'Kindly', 'Lively', 'Mighty',
  'Noble', 'Perky', 'Proud', 'Quirky', 'Shy', 'Spry', 'Swift', 'Tidy',
  'Wiggly', 'Witty', 'Zippy', 'Barefoot', 'Golden', 'Rainy', 'Windy', 'Wandering',
  'Whistling', 'Humming', 'Dancing', 'Surfing', 'Paddling', 'Drifting', 'Splashy', 'Sparkly',
  'Starry', 'Moonlit', 'Dewy', 'Mossy', 'Pebbly', 'Friendly', 'Steady', 'Twinkly',
  'Ticklish', 'Daydreaming', 'Strolling', 'Singing', 'Smiling', 'Waving', 'Speckled', 'Striped',
]);

/**
 * What a person on Kauaʻi would smile to be: the ones in the yard, the ones
 * on the reef, the ones at the refuge and up in the Alakaʻi. Hawaiian names
 * keep their ʻokina and kahakō, as the rest of the app does.
 */
export const ANIMALS = Object.freeze([
  'Honu', 'Nēnē', 'Gecko', 'Rooster', 'Mynah', 'Pueo', 'Monk Seal', 'Manta',
  'Humuhumu', 'ʻIʻiwi', 'Kōlea', 'Mongoose', 'Boar', 'Hen', 'Chick', 'ʻApapane',
  'ʻElepaio', 'ʻAmakihi', 'ʻAnianiau', 'ʻAkekeʻe', 'Puaiohi', 'ʻAlae ʻUla', 'Aeʻo', 'Koloa',
  'ʻIwa', 'Mōlī', 'Koaʻe', 'ʻAʻo', 'ʻUaʻu', 'Noio', 'ʻAukuʻu', 'ʻŪlili',
  'Hunakai', 'Egret', 'Dove', 'Cardinal', 'Shama', 'Francolin', 'Pheasant', 'ʻŌpeʻapeʻa',
  'Naiʻa', 'Koholā', 'Heʻe', 'Puhi', 'Uhu', 'Kala', 'Manini', 'Lauwiliwili',
  'Kīkākapu', 'Kihikihi', 'Hīnālea', 'Moi', 'ʻOʻopu', 'ʻŌpae', 'ʻAʻama', 'ʻOpihi',
  'Wana', 'Hīhīwai', 'Pinao', 'Pulelehua', 'Manō', 'Ulua', 'ʻAhi', 'Mahimahi',
  'Ono', 'Aku', 'ʻŌpelu', 'Akule', 'Weke', 'Pāpio', 'Goat', 'Bufo',
  'Anole', 'Skink', 'Ghost Crab', 'Hermit Crab', 'Sea Star', 'Seahorse', 'Honeybee', 'Monarch',
]);

const SECRET_NAME = 'anonymousNames';

/**
 * A configured secret shorter than this is not used. Everybody is shown one
 * input and its answer — their own id and their own name — so a key that can
 * be guessed can be checked against that pair at leisure, and then gives up
 * everybody else's. Thirty-two characters of anything random cannot be
 * guessed; "changeme" can. A short one is set aside for the server's own and
 * said so, once, the way a bad retention setting is.
 */
const SECRET_MIN_LENGTH = 32;

// Read once a process. The stored secret never changes under a running
// server, and a member list asks for it once a row.
let keptSecret;
let warnedOfShortSecret = false;

const configuredSecret = () => {
  const configured = Meteor.settings.anonymousNames?.secret;
  if (typeof configured === 'string' && configured.length >= SECRET_MIN_LENGTH) {
    return configured;
  }
  if (configured !== undefined && !warnedOfShortSecret) {
    warnedOfShortSecret = true;
    console.error(`[anonymous names] anonymousNames.secret is not a string of ${SECRET_MIN_LENGTH} or more characters and was ignored; the server is using its own.`);
  }
  return undefined;
};

const secret = () => {
  const configured = configuredSecret();
  if (configured) {
    return configured;
  }
  if (!keptSecret) {
    keptSecret = serverSecret(SECRET_NAME, () => crypto.randomBytes(32).toString('hex'));
  }
  return keptSecret;
};

/**
 * The keyed hash of a list of parts. The parts go in as JSON so that no two
 * different lists can ever spell the same input, and each use names itself in
 * the first part so that a name and a handle are never the same hash read two
 * ways.
 */
const keyedHash = parts => crypto.createHmac('sha256', secret()).update(JSON.stringify(parts)).digest();

/**
 * The name the hash gives this account on its `attempt`-th asking. Not yet
 * anybody's: anonymousNameFor decides that. Exported so a test can show that
 * a different secret gives different names, which is the whole defence.
 *
 * Four bytes pick each word. Against lists this short the unevenness of a
 * remainder is a few parts in a hundred million.
 */
export const derivedName = (userId, attempt = 0) => {
  const digest = keyedHash(['anonymous-name', userId, attempt]);
  const adjective = ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length];
  const animal = ANIMALS[digest.readUInt32BE(4) % ANIMALS.length];
  return `${adjective} ${animal}`;
};

/**
 * How many times the hash is asked again before the lists are treated as used
 * up. With nine names in ten taken, sixty-four askings still find a free one
 * all but once in a thousand; past that the person's first name gets a number
 * — "Sleepy Honu 2" — and the numbers do not run out in any town this is for.
 */
const WALK_LIMIT = 64;
const NUMBER_LIMIT = 10000;

const candidateName = (userId, attempt, derive) => (attempt < WALK_LIMIT
  ? derive(userId, attempt)
  : `${derive(userId, 0)} ${(attempt - WALK_LIMIT) + 2}`);

const NAMES_UNAVAILABLE = 'Made-up names are not available just now. Try again in a moment.';

/**
 * No name is given out until the unique index is known to stand.
 *
 * Profiles.js builds it at startup like every other index, and startup is too
 * late for the first caller: Mongo.js backfills existing profiles while the
 * server's files are still loading. Naming people with nothing holding the
 * names apart would let two of them share one, and an index cannot then be
 * built over the pair — so the uniqueness would be gone for good, quietly.
 * Asking for an index that already exists costs one round trip, once a
 * process. A failure is not remembered, so the next caller asks again.
 *
 * The error that comes out carries no detail, on purpose: a duplicate-key
 * message quotes the value it tripped on.
 */
let indexBuilt;

const waitForUniqueIndex = () => {
  if (!indexBuilt) {
    indexBuilt = Profiles.collection.rawCollection().createIndex(ANONYMOUS_NAME_INDEX.keys, ANONYMOUS_NAME_INDEX.options);
  }
  try {
    Promise.await(indexBuilt);
  } catch (error) {
    indexBuilt = undefined;
    throw new Meteor.Error('names-unavailable', NAMES_UNAVAILABLE);
  }
};

/**
 * This person's made-up name, given to them now if they have none.
 *
 * The write is the check. "Is it free?" and then "take it" is passed by two
 * sign-ups landing together, each told the name is free; so the name is
 * simply written, and the unique index is what says no. On that answer the
 * walk moves on to the next candidate. The write also insists the profile
 * still has no name, so two calls for the SAME person cannot leave them with
 * whichever landed second: the loser reads back what the winner wrote.
 *
 * A name lives on a profile, so an account with no profile has none — there
 * is nowhere to keep it, and a name that is not kept is not unique.
 *
 * `derive` is for a test, which has no other way to make two accounts hash
 * alike.
 */
export const anonymousNameFor = (userId, { derive = derivedName } = {}) => {
  if (!userId) {
    return undefined;
  }
  const kept = () => Profiles.collection.findOne({ userId }, { fields: { anonymousName: 1 } });
  const profile = kept();
  if (!profile || profile.anonymousName) {
    return profile?.anonymousName;
  }
  waitForUniqueIndex();
  for (let attempt = 0; attempt < WALK_LIMIT + NUMBER_LIMIT; attempt += 1) {
    const name = candidateName(userId, attempt, derive);
    try {
      const written = Profiles.collection.update(
        { _id: profile._id, anonymousName: { $exists: false } },
        { $set: { anonymousName: name } },
      );
      return written === 1 ? name : kept()?.anonymousName;
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
    }
  }
  throw new Meteor.Error('names-unavailable', NAMES_UNAVAILABLE);
};

/**
 * The same, for the places a profile is made — where a failure to name
 * somebody must not be a failure to sign them up. The name is given again
 * wherever it is next needed, and at the next boot's backfill. What is logged
 * is the kind of error and never its message, for the reason above.
 */
export const nameNewProfile = userId => {
  try {
    anonymousNameFor(userId);
  } catch (error) {
    console.error(`[anonymous names] a new profile was left unnamed for now: ${error.error || error.code || error.name}`);
  }
};

/**
 * What a row of an anonymous group's member list is known by, for the things
 * its owner will be able to DO to a row — blocking a member is the first.
 *
 * It cannot be the userId, which is the person. It cannot be the made-up name
 * either: that is the same in every group, so a block list keyed by it would
 * say, to anyone who could read two of them, that one person is in both. A
 * handle is the keyed hash of the group AND the account: steady inside one
 * group, different in the next, and no use to a browser, which cannot turn it
 * back into an account or make one for an account it has in mind.
 *
 * Worked out on asking and stored nowhere — so, unlike a name, it DOES move
 * if the secret is replaced. Whatever is one day keyed by it has to be
 * re-keyed by the same hand that replaces the secret.
 */
export const memberHandle = (clubId, userId) => keyedHash(['member-handle', clubId, userId])
  .toString('base64url')
  .slice(0, 16);

/**
 * The day somebody joined, and not the moment.
 *
 * An instant is a fingerprint. 'clubs.members' never shows one membership
 * both by name and made-up, and that is what keeps a named list from being
 * the key to this one. But the moment somebody joined is also written where
 * their account is — the operations log holds 'profileClubs.add' against a
 * person to the millisecond, and leaves out only which group — and the same
 * moment beside a made-up name would fill that in. A day is all the page
 * ever drew, and it is all that is sent: noon on the island, so a browser a
 * few hours east or west still prints the same date.
 */
const islandDay = date => (date instanceof Date
  ? moment.tz(date, LISTING_TIME_ZONE).startOf('day').add(12, 'hours').toDate()
  : undefined);

/**
 * Memberships as the person who runs an anonymous group is shown them:
 * a handle, a made-up name and the day they joined, and NOTHING else — no
 * userId, no real name, no picture, no address.
 *
 * In order of day and then of name, not of joining: within a day the order
 * people arrived in is one more thing that could be matched against a list
 * seen earlier. A membership with no date sorts first, as the oldest.
 *
 * The names are read in one query. Only a profile still without one — made
 * around every path that gives a name, or left over from a boot that could
 * not — costs a write of its own, once.
 */
export const anonymousMemberRows = (clubId, memberships) => {
  const named = new Map(Profiles.collection.find(
    { userId: { $in: memberships.map(membership => membership.userId) }, anonymousName: { $exists: true } },
    { fields: { userId: 1, anonymousName: 1 } },
  ).map(profile => [profile.userId, profile.anonymousName]));

  return memberships
    .map(({ userId, createdAt }) => ({
      handle: memberHandle(clubId, userId),
      anonymousName: named.get(userId) || anonymousNameFor(userId) || '',
      joinedAt: islandDay(createdAt),
    }))
    .sort((a, b) => ((a.joinedAt?.getTime() || 0) - (b.joinedAt?.getTime() || 0))
      || a.anonymousName.localeCompare(b.anonymousName));
};
