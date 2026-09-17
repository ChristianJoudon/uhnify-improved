/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { Profiles } from '../profiles/Profiles';
import { IMAGE_DATA_URL_MAX } from '../listing/limits';
import { ListingPhotos } from './ListingPhotos';
import { insertWithPhoto, photoFieldFor, removePhoto, savePhoto } from './photoStore';
import { callAs, errorFrom, makeClub, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Photos used to be part of the document they illustrate, so there was
 * nothing to get out of step. Now there are two records for every photo — the
 * bytes, and the path that points at them — and every test here is about one
 * of the ways two records can come to disagree: a path with no photo behind
 * it, a photo with no listing in front of it, or a path that points at
 * somebody else's.
 */
if (Meteor.isServer) {
  const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(61, 9)]);
  const jpeg = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
  const png = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

  const rowFor = (kind, ownerId) => ListingPhotos.collection.findOne({ kind, ownerId });
  const photoCount = () => ListingPhotos.collection.find().count();

  /** The clock is the version, so two saves have to fall in different
      milliseconds for the test to see the path change. */
  const tick = () => Meteor._sleepForMs(3);

  const reset = () => {
    resetAll();
    ListingPhotos.collection.remove({});
  };

  describe('photo store', function () {
    beforeEach(reset);

    describe('savePhoto', function () {
      it('keeps the bytes apart and answers with where they are served from', function () {
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        const row = rowFor('event', 'abc123');
        assert.equal(path, `/photo/event/abc123?v=${row.updatedAt.getTime()}`);
        assert.equal(row.contentType, 'image/jpeg');
        assert.isFalse(row.data.startsWith('data:'), 'the payload alone');
        assert.isTrue(Buffer.from(row.data, 'base64').equals(JPEG_BYTES));
        assert.equal(row.bytes, JPEG_BYTES.length);
      });

      it('counts the bytes whatever the padding', function () {
        [0, 1, 2].forEach(extra => {
          const bytes = Buffer.concat([JPEG_BYTES, Buffer.alloc(extra, 1)]);
          savePhoto({ kind: 'club', ownerId: `pad${extra}`, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` });
          assert.equal(rowFor('club', `pad${extra}`).bytes, bytes.length);
        });
      });

      it('replaces the last photo rather than keeping both, under a new address', function () {
        const first = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        tick();
        const second = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: png });
        assert.notEqual(first, second, 'the address has to change, or a year-long cache shows the old photo');
        assert.equal(photoCount(), 1);
        assert.equal(rowFor('event', 'abc123').contentType, 'image/png');
      });

      it('keeps one owner’s photo apart from another’s, and one kind’s from another’s', function () {
        savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        savePhoto({ kind: 'club', ownerId: 'abc123', dataUrl: png });
        savePhoto({ kind: 'event', ownerId: 'def456', dataUrl: png });
        assert.equal(photoCount(), 3);
        assert.equal(rowFor('event', 'abc123').contentType, 'image/jpeg');
      });

      it('refuses what imageProblem refuses, and stores nothing', function () {
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==' })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: jpeg.padEnd(IMAGE_DATA_URL_MAX + 1, 'A') })), 'image-too-large');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })), 'invalid-image');
        // Things imageProblem allows as an image but which are not an upload.
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: 'https://example.org/a.jpg' })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: '/photo/event/a?v=1' })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: undefined })), 'invalid-image');
        assert.equal(photoCount(), 0);
      });

      /**
       * imageProblem reads the head and stops. The server decodes the rest
       * now, and Node's decoder skips what it does not know instead of
       * failing, so the size stored and the size served would disagree.
       */
      it('refuses a payload that is not base64 from end to end', function () {
        const head = JPEG_BYTES.toString('base64');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: `data:image/jpeg;base64,${head}<script>` })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: `data:image/jpeg;base64,${head}\n${head}` })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a', dataUrl: `data:image/jpeg;base64,${head}=A` })), 'invalid-image', 'padding is the end');
        assert.equal(photoCount(), 0);
      });

      it('stores nothing under a key the route would refuse to serve', function () {
        assert.equal(errorFrom(() => savePhoto({ kind: 'poster', ownerId: 'abc123', dataUrl: jpeg })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'made-by-hand', dataUrl: jpeg })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: '../club/abc', dataUrl: jpeg })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: { $ne: null }, dataUrl: jpeg })), 'invalid-image');
        assert.equal(errorFrom(() => savePhoto({ kind: 'event', ownerId: 'a'.repeat(41), dataUrl: jpeg })), 'invalid-image');
        assert.equal(photoCount(), 0);
      });
    });

    describe('photoFieldFor', function () {
      const mine = { kind: 'event', ownerId: 'mine111' };

      it('stores an upload and hands back its path', function () {
        const value = photoFieldFor({ ...mine, value: jpeg, previous: '/images/codingWorkshop.png' });
        assert.match(value, /^\/photo\/event\/mine111\?v=\d+$/);
        assert.isTrue(Buffer.from(rowFor('event', 'mine111').data, 'base64').equals(JPEG_BYTES));
      });

      it('takes the photo down when the form sends no image, and returns what it was sent', function () {
        ['', undefined].forEach(value => {
          const previous = savePhoto({ ...mine, dataUrl: jpeg });
          assert.strictEqual(photoFieldFor({ ...mine, value, previous }), value);
          assert.isUndefined(rowFor('event', 'mine111'));
        });
      });

      it('leaves other owners’ photos alone when it takes one down', function () {
        savePhoto({ ...mine, dataUrl: jpeg });
        savePhoto({ kind: 'club', ownerId: 'mine111', dataUrl: jpeg });
        savePhoto({ kind: 'event', ownerId: 'theirs222', dataUrl: jpeg });
        photoFieldFor({ ...mine, value: '' });
        assert.equal(photoCount(), 2);
      });

      it('keeps an unchanged path exactly, without touching the photo', function () {
        const previous = savePhoto({ ...mine, dataUrl: jpeg });
        const before = rowFor('event', 'mine111');
        assert.equal(photoFieldFor({ ...mine, value: previous, previous }), previous);
        assert.deepEqual(rowFor('event', 'mine111'), before);
      });

      /**
       * Two administrators open the same form; one replaces the photo; the
       * other saves. The second form is still holding the old address, and
       * writing that back would put a stale version on the document.
       */
      it('answers a stale path of its own with the photo that is there now', function () {
        const stale = savePhoto({ ...mine, dataUrl: jpeg });
        tick();
        const current = savePhoto({ ...mine, dataUrl: png });
        assert.equal(photoFieldFor({ ...mine, value: stale, previous: current }), current);
        assert.equal(photoFieldFor({ ...mine, value: '/photo/event/mine111', previous: current }), current, 'no version at all');
        assert.equal(rowFor('event', 'mine111').contentType, 'image/png', 'and the photo is not touched');
      });

      it('reads a path of its own with no photo behind it as no photo', function () {
        assert.equal(photoFieldFor({ ...mine, value: '/photo/event/mine111?v=5', previous: '/images/codingWorkshop.png' }), '');
      });

      /**
       * The refusal that matters. A path is a string in a form, and without
       * this an event could be saved wearing a private group's photo — or a
       * profile wearing another member's face.
       */
      it('refuses a path that names another owner, or another kind', function () {
        const theirs = savePhoto({ kind: 'event', ownerId: 'theirs222', dataUrl: jpeg });
        const myOwn = savePhoto({ ...mine, dataUrl: png });
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: theirs, previous: myOwn })), 'invalid-image');
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: theirs, previous: theirs })), 'invalid-image', 'even if the document somehow already said so');
        assert.equal(errorFrom(() => photoFieldFor({ kind: 'club', ownerId: 'mine111', value: myOwn, previous: myOwn })), 'invalid-image', 'same id, other kind');
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: '/photo/event/mine1110?v=1' })), 'invalid-image', 'a longer id that starts the same');
        assert.equal(photoCount(), 2, 'a refusal changes nothing');
        assert.equal(rowFor('event', 'mine111').contentType, 'image/png');
      });

      it('stores an app image or an https link as written, and takes down the upload it replaces', function () {
        ['/images/codingWorkshop.png', 'https://example.org/logo.png'].forEach(value => {
          const previous = savePhoto({ ...mine, dataUrl: jpeg });
          assert.equal(photoFieldFor({ ...mine, value, previous }), value);
          assert.isUndefined(rowFor('event', 'mine111'));
        });
      });

      it('refuses what is not an image, and leaves the stored photo as it was', function () {
        const previous = savePhoto({ ...mine, dataUrl: jpeg });
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: 'http://elsewhere.example/pixel.gif', previous })), 'invalid-image');
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: '/photo/event/', previous })), 'invalid-image');
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==', previous })), 'invalid-image');
        assert.equal(errorFrom(() => photoFieldFor({ ...mine, value: jpeg.padEnd(IMAGE_DATA_URL_MAX + 1, 'A'), previous })), 'image-too-large');
        assert.isTrue(Buffer.from(rowFor('event', 'mine111').data, 'base64').equals(JPEG_BYTES));
      });

      it('removePhoto says whether there was one', function () {
        savePhoto({ ...mine, dataUrl: jpeg });
        assert.equal(removePhoto(mine), 1);
        assert.equal(removePhoto(mine), 0);
      });
    });

    describe('insertWithPhoto', function () {
      const record = () => ({
        eventID: 0,
        title: 'Made with a photo',
        date: new Date(Date.now() + 86400000),
        location: 'Līhuʻe',
      });
      const insert = (value, overrides = {}) => insertWithPhoto({
        kind: 'event', collection: Events.collection, field: 'image', record: { ...record(), ...overrides }, value,
      });

      it('makes the listing, then the photo under its _id, then sets the path', function () {
        const id = insert(jpeg);
        const row = rowFor('event', id);
        assert.equal(Events.collection.findOne(id).image, `/photo/event/${id}?v=${row.updatedAt.getTime()}`);
        assert.isTrue(Buffer.from(row.data, 'base64').equals(JPEG_BYTES));
      });

      /**
       * Every subscriber is sent an insert as it happens. If the record went
       * in carrying the data URL, even to be replaced a moment later, the
       * half-megabyte would still have gone down every open connection.
       */
      it('never writes the data URL to the listing, not even on the way', function () {
        const writes = [];
        const watched = {
          insert: doc => { writes.push(doc); return Events.collection.insert(doc); },
          update: (id, modifier) => { writes.push(modifier); return Events.collection.update(id, modifier); },
          remove: id => Events.collection.remove(id),
        };
        insertWithPhoto({ kind: 'event', collection: watched, field: 'image', record: record(), value: jpeg });
        assert.lengthOf(writes, 2);
        assert.notInclude(JSON.stringify(writes), 'data:image');
        assert.notProperty(writes[0], 'image');
      });

      it('puts anything that is not an upload in with the record, in one write', function () {
        const stock = insert('/images/codingWorkshop.png');
        assert.equal(Events.collection.findOne(stock).image, '/images/codingWorkshop.png');
        assert.notProperty(Events.collection.findOne(insert('')), 'image');
        assert.notProperty(Events.collection.findOne(insert(undefined)), 'image');
        assert.equal(photoCount(), 0);
      });

      it('refuses a bad image before anything is made', function () {
        assert.equal(errorFrom(() => insert('http://elsewhere.example/pixel.gif')), 'invalid-image');
        assert.equal(errorFrom(() => insert('data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==')), 'invalid-image');
        assert.equal(errorFrom(() => insert(`${jpeg}<script>`)), 'invalid-image');
        assert.equal(errorFrom(() => insert(jpeg.padEnd(IMAGE_DATA_URL_MAX + 1, 'A'))), 'image-too-large');
        assert.equal(Events.collection.find().count(), 0);
        assert.equal(photoCount(), 0);
      });

      it('refuses any photo path: a listing that does not exist yet has no photo to name', function () {
        const theirs = savePhoto({ kind: 'event', ownerId: 'theirs222', dataUrl: jpeg });
        assert.equal(errorFrom(() => insert(theirs)), 'invalid-image');
        assert.equal(Events.collection.find().count(), 0);
        assert.equal(photoCount(), 1, 'and theirs is where it was');
      });

      /**
       * The order is forced — the photo is keyed by an _id the listing only
       * has once it exists — so the second half can fail with the first
       * already done. What must not be left is a listing standing on the wall
       * without the photo its owner chose, reported to them as an error.
       */
      it('takes the listing back out when the photo cannot be stored', function () {
        const { upsert } = ListingPhotos.collection;
        ListingPhotos.collection.upsert = () => { throw new Error('the database went away'); };
        try {
          assert.equal(errorFrom(() => insert(jpeg)), 'the database went away');
        } finally {
          ListingPhotos.collection.upsert = upsert;
        }
        assert.equal(Events.collection.find().count(), 0, 'no half-made listing');
        assert.equal(photoCount(), 0, 'and no photo without one');
      });

      it('takes the listing back out when its _id is one no photo can be kept under', function () {
        assert.equal(errorFrom(() => insert(jpeg, { _id: 'made-by-hand' })), 'invalid-image');
        assert.equal(Events.collection.find().count(), 0);
        assert.equal(photoCount(), 0);
      });
    });
  });

  /**
   * The same promises, kept by the methods people actually call. Each test
   * stores something the way a form does and then looks in both places.
   */
  describe('photos through the methods', function () {
    let user;
    let admin;
    let hostClubID;

    beforeEach(function () {
      reset();
      user = makeUser();
      admin = makeUser({ admin: true });
      hostClubID = Clubs.collection.findOne(makeClub()).clubID;
    });

    const eventForm = overrides => ({
      eventID: hostClubID,
      title: 'Beach cleanup',
      date: new Date(Date.now() + 86400000),
      location: 'Kealia',
      ...overrides,
    });
    const clubForm = overrides => ({
      name: 'Paddlers',
      description: 'We paddle.',
      location: 'Hanalei',
      meetingTime: 'Saturdays 7am',
      ...overrides,
    });
    const clubEdit = (club, overrides) => ({
      name: club.name, owner: club.owner, description: club.description, location: club.location, meetingTime: club.meetingTime, ...overrides,
    });
    const profileForm = overrides => ({
      firstName: 'Kai', lastName: 'Test', email: Profiles.collection.findOne({ userId: user }).email, bio: '', title: '', interests: [], ...overrides,
    });

    describe('events', function () {
      it('stores a path on the event and the bytes in the photo store', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        const event = Events.collection.findOne(id);
        assert.match(event.image, new RegExp(`^/photo/event/${id}\\?v=\\d+$`));
        assert.notInclude(JSON.stringify(event), 'data:image', 'nothing inline is left on the document');
        assert.isTrue(Buffer.from(rowFor('event', id).data, 'base64').equals(JPEG_BYTES));
      });

      it('stores no photo for an event made without one', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: '' }));
        assert.equal(Events.collection.findOne(id).image, '/images/codingWorkshop.png');
        assert.equal(photoCount(), 0);
      });

      it('cannot be made wearing another listing’s photo', function () {
        const theirs = Events.collection.findOne(callAs(user, 'Events.insert', eventForm({ image: jpeg }))).image;
        assert.equal(errorFrom(() => callAs(user, 'Events.insert', eventForm({ title: 'Copycat', image: theirs }))), 'invalid-image');
        assert.equal(Events.collection.find().count(), 1);
      });

      it('keeps the photo when an edit sends its path back unchanged', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        const { image } = Events.collection.findOne(id);
        const before = rowFor('event', id);
        callAs(admin, 'Events.update', id, eventForm({ title: 'Renamed', image }));
        assert.equal(Events.collection.findOne(id).image, image);
        assert.deepEqual(rowFor('event', id), before);
      });

      it('replaces the photo, and changes its address, when an edit uploads a new one', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        const { image } = Events.collection.findOne(id);
        tick();
        callAs(admin, 'Events.update', id, eventForm({ image: png }));
        assert.notEqual(Events.collection.findOne(id).image, image);
        assert.match(Events.collection.findOne(id).image, new RegExp(`^/photo/event/${id}\\?v=\\d+$`));
        assert.equal(photoCount(), 1);
        assert.isTrue(Buffer.from(rowFor('event', id).data, 'base64').equals(PNG_BYTES));
      });

      it('removes the stored photo when an edit clears it', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        callAs(admin, 'Events.update', id, eventForm({ image: '' }));
        assert.equal(Events.collection.findOne(id).image, '/images/codingWorkshop.png');
        assert.isUndefined(rowFor('event', id));
      });

      it('refuses an edit that points the event at another’s photo, and changes nothing', function () {
        const mine = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        const theirs = callAs(user, 'Events.insert', eventForm({ title: 'Theirs', image: png }));
        const before = Events.collection.findOne(mine).image;
        assert.equal(errorFrom(() => callAs(admin, 'Events.update', mine, eventForm({ image: Events.collection.findOne(theirs).image }))), 'invalid-image');
        assert.equal(Events.collection.findOne(mine).image, before);
        assert.equal(photoCount(), 2);
      });

      /**
       * The photo is the one field whose check writes. It runs after the
       * others so that an edit refused over its title has not already
       * replaced the photo the person was told was unchanged.
       */
      it('does not replace the photo for an edit that is refused over something else', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        assert.equal(errorFrom(() => callAs(admin, 'Events.update', id, eventForm({ title: ' ', image: png }))), 'required');
        assert.isTrue(Buffer.from(rowFor('event', id).data, 'base64').equals(JPEG_BYTES));
      });

      it('keeps nothing for an edit aimed at an event that is not there', function () {
        callAs(admin, 'Events.update', 'noSuchEvent1', eventForm({ image: jpeg }));
        assert.equal(photoCount(), 0);
      });

      it('removes the stored photo with the event', function () {
        const id = callAs(user, 'Events.insert', eventForm({ image: jpeg }));
        const other = callAs(user, 'Events.insert', eventForm({ title: 'Stays', image: png }));
        callAs(admin, 'Events.remove', id);
        assert.isUndefined(rowFor('event', id));
        assert.isOk(rowFor('event', other), 'and nobody else’s');
      });
    });

    describe('groups', function () {
      it('stores a path on the group and the bytes in the photo store', function () {
        const id = callAs(user, 'Clubs.insert', clubForm({ image: jpeg }));
        const club = Clubs.collection.findOne(id);
        assert.match(club.image, new RegExp(`^/photo/club/${id}\\?v=\\d+$`));
        assert.notInclude(JSON.stringify(club), 'data:image');
        assert.isTrue(Buffer.from(rowFor('club', id).data, 'base64').equals(JPEG_BYTES));
      });

      it('leaves the photo alone when an edit says nothing about it, and removes it when the edit clears it', function () {
        const id = callAs(user, 'Clubs.insert', clubForm({ image: jpeg }));
        const made = Clubs.collection.findOne(id);
        callAs(admin, 'Clubs.update', id, clubEdit(made, { description: 'We paddle further.' }));
        assert.equal(Clubs.collection.findOne(id).image, made.image);
        assert.isOk(rowFor('club', id));

        callAs(admin, 'Clubs.update', id, clubEdit(made, { image: made.image }));
        assert.equal(Clubs.collection.findOne(id).image, made.image, 'sent back unchanged');

        callAs(admin, 'Clubs.update', id, clubEdit(made, { image: '' }));
        assert.notProperty(Clubs.collection.findOne(id), 'image');
        assert.isUndefined(rowFor('club', id));
      });

      it('does not replace the photo for an edit that is refused over something else', function () {
        const id = callAs(user, 'Clubs.insert', clubForm({ image: jpeg }));
        const made = Clubs.collection.findOne(id);
        assert.equal(errorFrom(() => callAs(admin, 'Clubs.update', id, clubEdit(made, { contactInfo: 'c'.repeat(5000), image: png }))), 'too-long');
        assert.equal(rowFor('club', id).contentType, 'image/jpeg');
      });

      it('cannot be pointed at an event’s photo, or another group’s', function () {
        const id = callAs(user, 'Clubs.insert', clubForm({ image: jpeg }));
        const other = callAs(user, 'Clubs.insert', clubForm({ name: 'Others', image: png }));
        const eventId = callAs(user, 'Events.insert', eventForm({ image: png }));
        const made = Clubs.collection.findOne(id);
        [Clubs.collection.findOne(other).image, Events.collection.findOne(eventId).image].forEach(image => {
          assert.equal(errorFrom(() => callAs(admin, 'Clubs.update', id, clubEdit(made, { image }))), 'invalid-image');
        });
        assert.equal(Clubs.collection.findOne(id).image, made.image);
      });

      it('removes the stored photo with the group', function () {
        const id = callAs(user, 'Clubs.insert', clubForm({ image: jpeg }));
        callAs(admin, 'Clubs.remove', id);
        assert.isUndefined(rowFor('club', id));
      });
    });

    describe('profiles', function () {
      const profileOf = userId => Profiles.collection.findOne({ userId });

      it('stores a path on the profile, keyed by the profile’s own _id', function () {
        callAs(user, 'Profiles.update', profileForm({ picture: jpeg }));
        const profile = profileOf(user);
        assert.match(profile.picture, new RegExp(`^/photo/profile/${profile._id}\\?v=\\d+$`));
        assert.isTrue(Buffer.from(rowFor('profile', profile._id).data, 'base64').equals(JPEG_BYTES));
      });

      it('leaves the photo alone when the form is saved without one', function () {
        callAs(user, 'Profiles.update', profileForm({ picture: jpeg }));
        const { picture, _id } = profileOf(user);
        callAs(user, 'Profiles.update', profileForm({ bio: 'New bio.' }));
        assert.equal(profileOf(user).picture, picture);
        assert.isOk(rowFor('profile', _id));
      });

      it('takes the photo down when asked to', function () {
        callAs(user, 'Profiles.update', profileForm({ picture: jpeg }));
        const { _id } = profileOf(user);
        callAs(user, 'Profiles.update', profileForm({ picture: '' }));
        assert.notProperty(profileOf(user), 'picture');
        assert.isUndefined(rowFor('profile', _id));
      });

      it('cannot wear another member’s photo', function () {
        callAs(admin, 'Profiles.update', { ...profileForm(), email: profileOf(admin).email, picture: png });
        assert.equal(errorFrom(() => callAs(user, 'Profiles.update', profileForm({ picture: profileOf(admin).picture }))), 'invalid-image');
        assert.notInclude(`${profileOf(user).picture}`, '/photo/');
      });

      it('keeps the photo through createUserProfile, which updates the profile in place', function () {
        callAs(user, 'Profiles.update', profileForm({ picture: jpeg }));
        const { picture, email } = profileOf(user);
        callAs(user, 'createUserProfile', null, email, 'Kai', 'Again');
        assert.equal(profileOf(user).picture, picture);
      });

      it('removes the stored photo with the profile', function () {
        callAs(user, 'Profiles.update', profileForm({ picture: jpeg }));
        const { _id } = profileOf(user);
        callAs(admin, 'Profiles.remove', _id);
        assert.isUndefined(rowFor('profile', _id));
      });
    });
  });
}
