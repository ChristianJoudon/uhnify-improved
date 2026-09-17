import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { Interests } from '../../api/interests/Interests';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { parseMeetingTime } from '../../api/club/schedule';
import { ensureRecommendationScaffold } from './RecommendationScaffold';
import {
  backfillListingCounts,
  dropRedundantCreatedBy,
  movePhotosOutOfDocuments,
  redactParticipationAudit,
  renameInterestedSwipes,
} from './migrations';

/* eslint-disable no-console */

const normalizeDate = value => (value instanceof Date ? value : new Date(value));

/**
 * The directory itself, generated from the Kauaʻi public register. It lives in
 * private/ rather than in Meteor.settings because settings is configuration,
 * this is data, and Meteor caps a settings file at 64k.
 */
const directory = (() => {
  try {
    // `Assets` is a server global in Meteor 2.x, not an importable package.
    return JSON.parse(Assets.getText('seed-kauai.json'));
  } catch (error) {
    console.log('No seed directory found; starting empty.');
    return { clubs: [], events: [] };
  }
})();

const seedCollection = (collection, defaultData, label, addFunction) => {
  if (collection.find().count() === 0 && defaultData?.length) {
    defaultData.forEach(data => addFunction(data));
    console.log(`Seeded ${defaultData.length} ${label}.`);
  }
};

/**
 * Seed records pass through as authored.
 *
 * The importer already writes exactly the schema's shape and — deliberately —
 * omits any key the source never published, because the card schema treats a
 * missing key as "draw no row" and a defaulted one as content. Enumerating
 * fields here would silently reintroduce the defaults the import removed
 * ('Other' categories, a stock image on every event) and would need editing
 * every time a field is added. Only dates need help, since JSON has none.
 */
const withDates = data => {
  const record = { ...data, date: data.date ? normalizeDate(data.date) : undefined };
  if (data.endDate) {
    record.endDate = normalizeDate(data.endDate);
  }
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
};

const addClub = data => Clubs.collection.insert(withDates(data));

const addEvent = data => Events.collection.insert(withDates(data));

const addInterest = data => {
  console.log(`  Adding interest: ${data.name}`);
  Interests.collection.insert(data);
};

/**
 * Seed the demo accounts' profiles — once, and never again.
 *
 * This used to `$set` the whole seed shape over any profile that already
 * existed, on EVERY server start. Seeding is a startup task, so the effect was
 * that restarting the dev server silently reverted the signed-in account's
 * picture, name, title, bio AND interests to the values in settings.json. From
 * the inside that looks exactly like "my profile changes didn't save": they
 * did save, they were reactive, they survived a reload — and then a restart
 * some minutes later put them back. Everything editable on the Customize page
 * went, not just the photo.
 *
 * A default belongs to a profile that does not exist yet. Once someone owns
 * one, it is theirs. The only thing still re-synced is the link to the account
 * document, because a reset users collection issues new _ids and an unlinked
 * profile is one nobody can reach.
 */
const syncDefaultProfiles = () => {
  Meteor.settings.defaultProfiles?.forEach(defaultProfile => {
    const user = Meteor.users.findOne({ username: defaultProfile.email });
    const existingProfile = Profiles.collection.findOne({ email: defaultProfile.email });

    if (!existingProfile) {
      Profiles.collection.insert({
        UH_ID: defaultProfile.UH_ID,
        userId: user?._id,
        email: defaultProfile.email,
        firstName: defaultProfile.firstName,
        lastName: defaultProfile.lastName,
        bio: defaultProfile.bio,
        title: defaultProfile.title,
        picture: defaultProfile.picture,
        interests: defaultProfile.interests || [],
      });
      return;
    }

    if (user?._id && user._id !== existingProfile.userId) {
      Profiles.collection.update(existingProfile._id, { $set: { userId: user._id } });
    }
  });
};

const seedProfileClubs = () => {
  if (ProfileClubs.collection.find().count() > 0) {
    return;
  }
  Meteor.settings.defaultProfilesClubs?.forEach(link => {
    const profile = Profiles.collection.findOne({ UH_ID: link.profileID });
    const club = Clubs.collection.findOne({ clubID: link.clubID });
    if (profile?.userId && club?._id) {
      ProfileClubs.collection.insert({ userId: profile.userId, clubId: club._id, createdAt: new Date() });
    }
  });
};

const seedEventClubs = () => {
  if (EventClubs.collection.find().count() > 0) {
    return;
  }
  Meteor.settings.defaultClubEvents?.forEach(link => {
    const club = Clubs.collection.findOne({ clubID: link.clubID });
    Events.collection.find({ eventID: link.eventID }).forEach(event => {
      if (club?._id && event?._id && !EventClubs.collection.findOne({ clubId: club._id, eventId: event._id })) {
        EventClubs.collection.insert({ clubId: club._id, eventId: event._id, createdAt: new Date() });
      }
    });
  });
};

/** Idempotent migration: derive structured schedules from legacy meetingTime strings. */
const migrateClubSchedules = () => {
  Clubs.collection.find({ schedule: { $exists: false } }).forEach(club => {
    const schedule = parseMeetingTime(club.meetingTime);
    if (schedule) {
      Clubs.collection.update(club._id, { $set: { schedule } });
    }
  });
  Clubs.collection.update({ tags: { $exists: false } }, { $set: { tags: [] } }, { multi: true });
};

seedCollection(Clubs.collection, directory.clubs, 'clubs', addClub);
seedCollection(Events.collection, directory.events, 'events', addEvent);
seedCollection(Interests.collection, Meteor.settings.defaultInterests, 'interests', addInterest);
syncDefaultProfiles();
seedProfileClubs();
seedEventClubs();
migrateClubSchedules();
// Nothing below depends on this, but the recommendation scaffold reads every
// group and event whole, and a listing still carrying its photo is half a
// megabyte of that reading — so the photos are out of the way before it runs.
// One line, and only when there is something to say. A photo that could not
// be moved is still stored inline and still sent to every visitor, which is
// worth a line on every boot until somebody replaces it. The migration has
// already named each one, and said apart which were refused as photos and
// which hit an error; this is the total, in the same two halves.
const movedPhotos = movePhotosOutOfDocuments();
if (Object.values(movedPhotos).some(count => count > 0)) {
  const stillInline = movedPhotos.left + movedPhotos.failed > 0
    ? ` Still inline: ${movedPhotos.left} refused as photos and left as they are, ${movedPhotos.failed} stopped by an error; each is named above.`
    : '';
  console.log(`Moved photos out of documents: ${movedPhotos.clubs} groups, ${movedPhotos.events} events, `
    + `${movedPhotos.profiles} profiles.${stillInline}`);
}
// No order to keep: it rewrites what the trail already holds and reads
// nothing else. Once, in effect — after the first boot it finds nothing.
const redactedAuditEntries = redactParticipationAudit();
if (redactedAuditEntries > 0) {
  console.log(`Took listing ids out of ${redactedAuditEntries} audit entries.`);
}
// After seeding, so a database seeded before the register dropped the field
// is cleaned on the same boot.
const clearedCreatedBy = dropRedundantCreatedBy();
if (clearedCreatedBy > 0) {
  console.log(`Cleared createdBy from ${clearedCreatedBy} events.`);
}
// Before the scaffold, not after: it replays every stored swipe to the
// recommender under the swipe's own decision, and 'interested' is a word
// neither of them uses any more.
const renamedSwipes = renameInterestedSwipes();
if (renamedSwipes.going + renamedSwipes.joined > 0) {
  console.log(`Renamed right swipes: ${renamedSwipes.going} to going, ${renamedSwipes.joined} to joined.`);
}
// After the rename, because Going is counted by that name; and after the
// seeded memberships above, which are written around the methods that keep
// the counts and so were never counted.
const correctedCounts = backfillListingCounts();
if (correctedCounts.clubs + correctedCounts.events > 0) {
  console.log(`Corrected counts: ${correctedCounts.clubs} groups' members, ${correctedCounts.events} events' going.`);
}
ensureRecommendationScaffold();
