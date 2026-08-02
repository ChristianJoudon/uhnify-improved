import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { Interests } from '../../api/interests/Interests';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { parseMeetingTime } from '../../api/club/schedule';

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

const syncDefaultProfiles = () => {
  Meteor.settings.defaultProfiles?.forEach(defaultProfile => {
    const user = Meteor.users.findOne({ username: defaultProfile.email });
    const existingProfile = Profiles.collection.findOne({ email: defaultProfile.email });
    const profile = {
      UH_ID: defaultProfile.UH_ID,
      userId: user?._id || existingProfile?.userId,
      email: defaultProfile.email,
      firstName: defaultProfile.firstName,
      lastName: defaultProfile.lastName,
      bio: defaultProfile.bio,
      title: defaultProfile.title,
      picture: defaultProfile.picture,
      interests: defaultProfile.interests || [],
    };

    if (existingProfile) {
      Profiles.collection.update(existingProfile._id, { $set: profile });
    } else {
      Profiles.collection.insert(profile);
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
