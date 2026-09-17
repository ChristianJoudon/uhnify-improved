/* eslint-env mocha */
/* eslint-disable no-console */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Friends } from '../friends/Friends';
import { ProfileClubs } from '../profile/ProfileClubs';
import { ANONYMOUS_NAME_INDEX, Profiles } from '../profiles/Profiles';
import { accountNameOf } from '../listing/ownership';
import { friendActivityPublication } from '../../startup/server/Publications';
import { callAs, errorFrom, makeClub, makeUser, resetAll } from '../../startup/server/testFixtures';
import {
  ADJECTIVES,
  ANIMALS,
  anonymousMemberRows,
  anonymousNameFor,
  derivedName,
  memberHandle,
  nameNewProfile,
} from './anonymousNames';
import { ServerSecrets, serverSecret } from './ServerSecrets';

/**
 * Made-up names, from the side of the person they keep out.
 *
 * Three people would like to know who "Sleepy Honu" is. A member of the app
 * with the directory open and this repository beside it: they have every
 * userId and both lists of words, and must still have nothing. The person who
 * runs the group: they are shown the name, and must be shown nothing WITH it
 * — not on the row, and not on yesterday's copy of the same list. And
 * somebody reading the server's log over a shoulder. An administrator is
 * the one person who may know, and the last test of each kind checks that
 * they still can — a name nobody can trace is not what was asked for either.
 */

/**
 * Run a publication as somebody. `documents` is what its cursors hold;
 * `collections` is every collection it touched, by cursor or by hand, which
 * is how a composite or a hand-published one is heard from too. Whatever it
 * started observing is stopped before this returns.
 */
const publishAs = (userId, name) => {
  const collections = new Set();
  const stops = [];
  const result = Meteor.server.publish_handlers[name].apply({
    userId,
    added: collection => collections.add(collection),
    changed: () => {},
    removed: () => {},
    ready: () => null,
    onStop: stop => stops.push(stop),
  }, []);
  stops.forEach(stop => stop());
  const cursors = [].concat(result || []).filter(cursor => typeof cursor?.fetch === 'function');
  cursors.forEach(cursor => collections.add(cursor._cursorDescription.collectionName));
  return { documents: cursors.flatMap(cursor => cursor.fetch()), collections: [...collections] };
};

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

const sentFrom = (node, args = []) => docsFrom(node.find(...args)).flatMap(doc => [
  doc,
  ...(node.children || []).flatMap(child => sentFrom(child, [doc, ...args])),
]);

const profileOf = userId => Profiles.collection.findOne({ userId });

if (Meteor.isServer) {
  describe('made-up names for anonymous groups', function () {
    // Several accounts per test, and each one is a password hashed.
    this.timeout(20000);

    const settingsBefore = Meteor.settings.anonymousNames;
    const useSecret = value => {
      Meteor.settings.anonymousNames = value === undefined ? undefined : { secret: value };
    };

    let owner;
    let member;
    let stranger;

    const anonymousClub = (overrides = {}) => makeClub({ owner: accountNameOf(owner), memberCount: 0, anonymous: true, ...overrides });

    beforeEach(function () {
      resetAll();
      useSecret(undefined);
      owner = makeUser();
      member = makeUser();
      stranger = makeUser();
    });

    after(function () {
      Meteor.settings.anonymousNames = settingsBefore;
    });

    describe('the words', function () {
      it('has enough of each that a name is not a guess among a handful', function () {
        assert.isAtLeast(ADJECTIVES.length, 64);
        assert.isAtLeast(ANIMALS.length, 64);
      });

      it('repeats none, so two different picks can never spell one name', function () {
        assert.lengthOf(new Set(ADJECTIVES), ADJECTIVES.length);
        assert.lengthOf(new Set(ANIMALS), ANIMALS.length);
        // An adjective is one word, which is what keeps "Sea Star" from being
        // read as an adjective and an animal.
        ADJECTIVES.forEach(word => assert.match(word, /^[A-Z][a-z]+$/, word));
      });

      /**
       * A unique index compares bytes. An ʻokina typed as an apostrophe, or a
       * kahakō as a letter and a combining mark, is a second spelling of one
       * name and a quiet way for two people to share it.
       */
      it('spells Hawaiian the one way the rest of the app does', function () {
        ANIMALS.forEach(word => {
          assert.equal(word, word.normalize('NFC'), word);
          assert.equal(word, word.trim(), word);
          assert.notMatch(word, /['’‘`]/, `${word}: an ʻokina is U+02BB`);
        });
        assert.include(ANIMALS, 'Nēnē');
        assert.include(ANIMALS, 'ʻIʻiwi');
      });
    });

    describe('one name each', function () {
      it('gives the same person the same name every time they are asked about', function () {
        const first = anonymousNameFor(member);
        assert.match(first, /^[A-Z][a-z]+ \S/);
        assert.equal(anonymousNameFor(member), first);
        assert.equal(profileOf(member).anonymousName, first, 'kept on the profile');
        assert.equal(first, derivedName(member), 'and with nobody in the way, it is the hash’s first answer');
      });

      it('and the same name in every anonymous group', function () {
        const circle = anonymousClub();
        const clinic = anonymousClub({ anonymous: false, categories: ['support_group'] });
        [circle, clinic].forEach(clubId => callAs(member, 'profileClubs.add', clubId));

        const names = [circle, clinic].map(clubId => callAs(owner, 'clubs.members', clubId)[0].anonymousName);
        assert.equal(names[0], names[1]);
        assert.equal(names[0], profileOf(member).anonymousName);
      });

      it('has none for nobody, and none for an account with no profile to keep it on', function () {
        assert.isUndefined(anonymousNameFor(undefined));
        assert.isUndefined(anonymousNameFor(''));
        Profiles.collection.remove({ userId: stranger });
        assert.isUndefined(anonymousNameFor(stranger));

        // They are still a row: the list has to agree with the count.
        const rows = anonymousMemberRows('aGroupId', [{ userId: stranger, createdAt: new Date() }]);
        assert.deepEqual(rows.map(row => row.anonymousName), ['']);
        assert.match(rows[0].handle, /^[A-Za-z0-9_-]{16}$/);
      });
    });

    /**
     * A few thousand names among a few hundred people collide as a matter of
     * course, so "walk on" is an everyday path and not a rare one.
     */
    describe('never two people under one name', function () {
      const fromList = names => (userId, attempt) => names[Math.min(attempt, names.length - 1)];

      it('walks on to the next answer when the first is taken', function () {
        const derive = fromList(['Sleepy Honu', 'Bold Rooster', 'Quiet Gecko']);
        assert.equal(anonymousNameFor(member, { derive }), 'Sleepy Honu');
        assert.equal(anonymousNameFor(stranger, { derive }), 'Bold Rooster');
        assert.equal(anonymousNameFor(owner, { derive }), 'Quiet Gecko');
        assert.equal(anonymousNameFor(member, { derive }), 'Sleepy Honu', 'and the first holder keeps theirs');
      });

      it('puts a number on the name once the lists have nothing left to give', function () {
        const derive = () => 'Sleepy Honu';
        assert.equal(anonymousNameFor(member, { derive }), 'Sleepy Honu');
        assert.equal(anonymousNameFor(stranger, { derive }), 'Sleepy Honu 2');
        assert.equal(anonymousNameFor(owner, { derive }), 'Sleepy Honu 3');
      });

      /**
       * What actually holds. "Is it free?" then "take it" is passed by two
       * sign-ups landing together; the index is not.
       */
      it('is held by the database, not by looking first', function () {
        const indexes = Promise.await(Profiles.collection.rawCollection().indexes());
        const index = indexes.find(entry => Object.keys(entry.key).join() === Object.keys(ANONYMOUS_NAME_INDEX.keys).join());
        assert.isOk(index, 'anonymousNameFor builds it before it gives out a name');
        assert.include(index, { unique: true, sparse: true });

        anonymousNameFor(member);
        const taken = profileOf(member).anonymousName;
        const error = errorFrom(() => Profiles.collection.update({ userId: stranger }, { $set: { anonymousName: taken } }));
        assert.isOk(error, 'a second holder is refused');
        // Sparse: the two profiles still without a name do not collide on "none".
        assert.equal(Profiles.collection.find({ anonymousName: { $exists: false } }).count(), 2);
      });

      /**
       * Two calls for the SAME person — two tabs, a sign-up and the boot's
       * backfill. The second write must not rename them.
       */
      it('lets a person who was named a moment ago keep that name', function () {
        const derive = userId => {
          // Somebody else's call lands between this one's read and its write.
          Profiles.collection.update({ userId, anonymousName: { $exists: false } }, { $set: { anonymousName: 'Bold Rooster' } });
          return 'Sleepy Honu';
        };
        assert.equal(anonymousNameFor(member, { derive }), 'Bold Rooster');
        assert.equal(profileOf(member).anonymousName, 'Bold Rooster');
      });
    });

    /**
     * The whole defence. The directory hands every signed-in user every
     * userId, and the lists are in a public repository.
     */
    describe('nothing anybody is sent is enough to work a name out', function () {
      const IDS = Array.from({ length: 24 }, (unused, index) => `account${index}xxxxxxxxx`);

      it('gives different names under a different secret, so the ids and the lists alone give nothing', function () {
        useSecret('the-first-secret-the-first-secret-0000');
        const first = IDS.map(id => derivedName(id));
        assert.deepEqual(IDS.map(id => derivedName(id)), first, 'steady under one secret');

        useSecret('another-secret-another-secret-11111111');
        const second = IDS.map(id => derivedName(id));
        const alike = first.filter((name, index) => name === second[index]).length;
        assert.isAtMost(alike, 1, 'two dozen accounts, and their names do not carry over');
        assert.isAbove(new Set(first).size, IDS.length / 2, 'and they are spread across the lists, not bunched');
      });

      it('makes its own secret when nobody configured one, keeps it on the server, and goes on using it', function () {
        assert.equal(serverSecret('a-test-secret', () => 'first'), 'first');
        assert.equal(serverSecret('a-test-secret', () => 'second'), 'first', 'the one that was kept wins');
        ServerSecrets.collection.remove('a-test-secret');

        // Nothing is configured here, so a name needs the kept secret: long,
        // random, and the same one from then on.
        const name = derivedName(member);
        const kept = ServerSecrets.collection.findOne('anonymousNames');
        assert.match(kept.value, /^[0-9a-f]{64}$/);
        assert.equal(derivedName(member), name);
        assert.deepEqual(ServerSecrets.collection.findOne('anonymousNames'), kept);
      });

      it('lets a configured secret win over the kept one', function () {
        const underKept = IDS.map(id => derivedName(id));
        useSecret(ServerSecrets.collection.findOne('anonymousNames').value);
        assert.deepEqual(IDS.map(id => derivedName(id)), underKept, 'the same key gives the same names, wherever it is read from');
        useSecret('another-secret-another-secret-11111111');
        assert.notDeepEqual(IDS.map(id => derivedName(id)), underKept);
      });

      /**
       * Everybody is shown their own id and their own name, which is one
       * input and its answer. A key that can be guessed can be checked
       * against that pair, and then it gives up everybody else's.
       */
      it('sets a secret short enough to guess aside for its own, and says so without saying what it was', function () {
        const underKept = IDS.map(id => derivedName(id));
        const said = [];
        const original = console.error;
        console.error = (...words) => said.push(words.join(' '));
        try {
          useSecret('changeme');
          assert.deepEqual(IDS.map(id => derivedName(id)), underKept);
        } finally {
          console.error = original;
        }
        assert.isAtMost(said.length, 1, 'once a process, not once a name');
        said.forEach(line => assert.notInclude(line, 'changeme'));
      });

      it('keeps that secret where no browser can reach: no methods, no publication', function () {
        assert.deepEqual(
          Object.keys(Meteor.server.method_handlers).filter(name => name.includes(ServerSecrets.name)),
          [],
          'not even the insert, update and remove every collection is born with',
        );
        derivedName(member);
        assert.isAbove(ServerSecrets.collection.find().count(), 0, 'there is a secret to leak');
        const admin = makeUser({ admin: true });
        Object.keys(Meteor.server.publish_handlers).forEach(name => {
          assert.notInclude(publishAs(admin, name).collections, ServerSecrets.name, name);
        });
      });

      it('does not rename anybody when the secret is replaced', function () {
        useSecret('the-first-secret-the-first-secret-0000');
        const name = anonymousNameFor(member);
        useSecret('another-secret-another-secret-11111111');
        assert.equal(anonymousNameFor(member), name);
      });

      it('is in nothing the directory sends', function () {
        [owner, member, stranger].forEach(userId => anonymousNameFor(userId));
        const sent = publishAs(stranger, 'Profiles.publication.directory').documents;
        assert.lengthOf(sent, 3);
        sent.forEach(doc => assert.notProperty(doc, 'anonymousName'));
        [owner, member].forEach(userId => assert.notInclude(JSON.stringify(sent), profileOf(userId).anonymousName));
      });

      it('is in nothing a friend is sent, however much the two of them share', function () {
        [member, stranger].forEach(userId => callAs(userId, 'Profiles.setFriendActivitySharing', true));
        callAs(member, 'friends.accept', callAs(stranger, 'friends.request', member));
        assert.equal(Friends.collection.find({ status: 'accepted' }).count(), 1);
        callAs(member, 'profileClubs.add', makeClub({ owner: accountNameOf(owner) }));
        callAs(member, 'profileClubs.add', anonymousClub());
        const name = anonymousNameFor(member);

        const sent = sentFrom(friendActivityPublication(stranger));
        assert.isTrue(sent.some(doc => doc.userId === member && doc.clubId), 'the feed is live, so its silence means something');
        sent.forEach(doc => assert.notProperty(doc, 'anonymousName'));
        assert.notInclude(JSON.stringify(sent), name);
      });

      it('is not in what an invite link says about a group', function () {
        const clubId = anonymousClub({ visibility: 'private', inviteToken: 'a-token-for-this-test-only' });
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: 'a-token-for-this-test-only' });
        const name = anonymousNameFor(member);
        const info = callAs(stranger, 'clubs.inviteInfo', 'a-token-for-this-test-only');
        assert.deepEqual(Object.keys(info).sort(), ['anonymous', 'clubId', 'memberCount', 'name']);
        assert.notInclude(JSON.stringify(info), name);
      });

      it('cannot be chosen, or changed, from a browser', function () {
        const { firstName, lastName, email } = profileOf(member);
        const edit = { firstName, lastName, email, bio: '', title: 'Student' };
        assert.isNull(errorFrom(() => callAs(member, 'Profiles.update', edit)), 'an ordinary edit goes through');
        assert.isOk(errorFrom(() => callAs(member, 'Profiles.update', { ...edit, anonymousName: 'Bold Rooster' })));
        assert.notEqual(profileOf(member).anonymousName, 'Bold Rooster');
      });
    });

    describe('who is shown one', function () {
      it('rides on a person’s own profile, and on nobody else’s copy of it', function () {
        [member, stranger].forEach(userId => anonymousNameFor(userId));
        const mine = publishAs(member, Profiles.userPublicationName).documents;
        assert.deepEqual(mine.map(doc => doc.anonymousName), [profileOf(member).anonymousName]);
        assert.deepEqual(publishAs(null, Profiles.userPublicationName).documents, []);
      });

      /** "So that they can still be traced" — by an administrator, and only there. */
      it('can be traced to an account by an administrator, and by nobody who is not one', function () {
        const admin = makeUser({ admin: true });
        const name = anonymousNameFor(member);
        const traced = publishAs(admin, Profiles.adminPublicationName).documents.find(doc => doc.anonymousName === name);
        assert.include(traced, { userId: member });
        assert.deepEqual(publishAs(owner, Profiles.adminPublicationName).documents, []);
      });

      it('shows the person who runs an anonymous group the names and nothing beside them, and refuses everybody else', function () {
        const clubId = anonymousClub();
        [member, stranger].forEach(userId => callAs(userId, 'profileClubs.add', clubId));

        const roster = callAs(owner, 'clubs.members', clubId);
        assert.sameMembers(roster.map(row => row.anonymousName), [member, stranger].map(userId => profileOf(userId).anonymousName));
        roster.forEach(row => {
          assert.deepEqual(Object.keys(row).sort(), ['anonymousName', 'handle', 'joinedAt']);
          ['userId', 'firstName', 'lastName', 'picture', 'email'].forEach(field => assert.notProperty(row, field));
        });
        const said = JSON.stringify(roster);
        [member, stranger].forEach(userId => {
          const { email, firstName } = profileOf(userId);
          [userId, email, firstName].forEach(fact => assert.notInclude(said, fact));
        });

        assert.equal(errorFrom(() => callAs(member, 'clubs.members', clubId)), 'not-authorized', 'a plain member');
        const outsider = makeUser();
        assert.equal(errorFrom(() => callAs(outsider, 'clubs.members', clubId)), 'not-authorized', 'a stranger');
        assert.equal(errorFrom(() => callAs(null, 'clubs.members', clubId)), 'not-logged-in');
      });

      /**
       * The owner's chair, over time. Everything above is one snapshot with
       * the right keys on it, and an owner does not need a userId ON a
       * made-up row if the same membership was sent with one yesterday. The
       * name is the same in every anonymous group, so pairing it once — in a
       * walking club — is knowing who "Sleepy Honu" is at the recovery
       * meeting the same person runs. 'clubs.members' did exactly that at
       * first: a named list, the switch, and the same people back as geckos.
       */
      const namedClub = () => makeClub({ owner: accountNameOf(owner), memberCount: 0 });
      const rosterOf = clubId => callAs(owner, 'clubs.members', clubId);

      it('never shows one person both ways: the switch does not turn a list of names into their made-up ones', function () {
        const clubId = namedClub();
        callAs(member, 'profileClubs.add', clubId);
        const name = anonymousNameFor(member);
        assert.include(rosterOf(clubId).map(row => row.userId), member, 'the owner has been sent them by id');

        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
        assert.deepEqual(rosterOf(clubId), [], 'counted, and on no list');
        assert.notInclude(JSON.stringify(rosterOf(clubId)), name);

        // Whoever joins NOW joins under the promise, and is the only row.
        callAs(stranger, 'profileClubs.add', clubId);
        assert.deepEqual(rosterOf(clubId).map(row => row.anonymousName), [profileOf(stranger).anonymousName]);

        // Switching back gives the owner nothing to subtract either: the
        // first person does not return by name beside a list they were
        // missing from, and the second does not turn into one.
        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false });
        const back = rosterOf(clubId);
        assert.deepEqual(back.map(row => Object.keys(row).sort()), [['anonymousName', 'handle', 'joinedAt']]);
        assert.notInclude(JSON.stringify(back), name);
        [member, stranger].forEach(userId => assert.notInclude(JSON.stringify(back), userId));
      });

      it('nor does a tag: whoever is in a group can call it a recovery group, and the list must not change its faces for that', function () {
        const clubId = namedClub();
        [owner, member].forEach(userId => callAs(userId, 'profileClubs.add', clubId));
        const name = anonymousNameFor(member);
        assert.include(rosterOf(clubId).map(row => row.userId), member);

        callAs(owner, 'clubs.addTag', clubId, 'recovery');
        assert.deepEqual(rosterOf(clubId), [], 'anonymous now, by what it is, and nobody the owner knew is made up');
        callAs(owner, 'clubs.removeTag', clubId, 'recovery');
        assert.notInclude(JSON.stringify(rosterOf(clubId)), name);
      });

      it('names a new profile as it is made, so the invitation page can say the name before anybody joins', function () {
        Profiles.collection.remove({ userId: stranger });
        callAs(stranger, 'createUserProfile', null, accountNameOf(stranger), 'New', 'Person');
        assert.match(profileOf(stranger).anonymousName, /\S \S/);

        // And one the seed made, adopted by its address, is named then too.
        Profiles.collection.update({ userId: member }, { $unset: { userId: '', anonymousName: '' } });
        callAs(member, 'createUserProfile', null, accountNameOf(member), 'Seeded', 'Person');
        assert.match(profileOf(member).anonymousName, /\S \S/);
      });
    });

    /**
     * What phase 4 will hold a block by. It has to mean nothing outside its
     * group, or a list of them says who is in two groups at once.
     */
    describe('a member’s handle', function () {
      it('is steady inside a group, different in the next, and different for the next person', function () {
        assert.equal(memberHandle('groupOne', member), memberHandle('groupOne', member));
        assert.notEqual(memberHandle('groupOne', member), memberHandle('groupTwo', member));
        assert.notEqual(memberHandle('groupOne', member), memberHandle('groupOne', stranger));
        // The two ids are not simply run together.
        assert.notEqual(memberHandle('ab', 'c'), memberHandle('a', 'bc'));
      });

      it('is sixteen characters that are safe in an address and hold no part of the account', function () {
        const handle = memberHandle('groupOne', member);
        assert.match(handle, /^[A-Za-z0-9_-]{16}$/);
        assert.notInclude(handle, member.slice(0, 6));
      });

      it('comes back the same from the method, and is not one a browser could make', function () {
        const circle = anonymousClub();
        const clinic = anonymousClub();
        [circle, clinic].forEach(clubId => callAs(member, 'profileClubs.add', clubId));
        const [inCircle, again, inClinic] = [circle, circle, clinic].map(clubId => callAs(owner, 'clubs.members', clubId)[0].handle);
        assert.equal(inCircle, again);
        assert.equal(inCircle, memberHandle(circle, member));
        assert.notEqual(inCircle, inClinic, 'the same person, and nothing on the two rows says so but the name');

        useSecret('another-secret-another-secret-11111111');
        assert.notEqual(memberHandle(circle, member), inCircle, 'it is keyed: without the secret there is no making one');
      });
    });

    /** A name beside an address, in a log, is the mapping itself. */
    describe('the log', function () {
      const LEVELS = ['log', 'warn', 'error'];

      /**
       * Everything the console was told while `work` ran. Swapped and put
       * back inside the one call, not in hooks around the test: the reporter
       * prints a test's own line before an afterEach would have run.
       */
      const overheard = work => {
        const said = [];
        const original = LEVELS.map(level => console[level]);
        LEVELS.forEach(level => {
          console[level] = (...words) => said.push(words.join(' '));
        });
        try {
          work();
        } finally {
          LEVELS.forEach((level, index) => {
            console[level] = original[index];
          });
        }
        return said;
      };

      it('never holds a name, when naming goes well', function () {
        let names;
        const said = overheard(() => {
          names = [owner, member, stranger].map(userId => anonymousNameFor(userId));
          const clubId = anonymousClub();
          callAs(member, 'profileClubs.add', clubId);
          callAs(owner, 'clubs.members', clubId);
        });
        names.forEach(name => assert.notInclude(said.join('\n'), name));
      });

      it('never holds one when naming goes wrong, and a sign-up is not failed by it', function () {
        const name = derivedName(member);
        const update = Profiles.collection.update;
        Profiles.collection.update = () => {
          throw new Error(`the database said no to { anonymousName: "${name}" }`);
        };
        let said;
        try {
          said = overheard(() => assert.doesNotThrow(() => nameNewProfile(member)));
        } finally {
          Profiles.collection.update = update;
        }
        assert.lengthOf(said, 1, 'it is said, once');
        assert.notInclude(said[0], name);
        assert.notInclude(said[0], member);
        assert.equal(anonymousNameFor(member), name, 'and the name is given the next time it is needed');
      });
    });

    it('lists an anonymous group by day and then by name, so the order says nothing of who came first', function () {
      const clubId = anonymousClub();
      const day = new Date('2026-09-03T20:00:00Z');
      [owner, member, stranger].forEach((userId, index) => ProfileClubs.collection.insert({
        userId, clubId, createdAt: new Date(day.getTime() + index * 1000), joinedAnonymous: true,
      }));
      const names = callAs(owner, 'clubs.members', clubId).map(row => row.anonymousName);
      assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
    });
  });
}
