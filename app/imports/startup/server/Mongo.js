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

const seedCollection = (collection, defaultData, label, addFunction) => {
  if (collection.find().count() === 0 && defaultData?.length) {
    console.log(`Creating default data for ${label}.`);
    defaultData.forEach(data => addFunction(data));
  }
};

const addClub = data => {
  console.log(`  Adding club: ${data.name}`);
  Clubs.collection.insert({
    clubID: data.clubID,
    name: data.name,
    owner: data.owner,
    description: data.description,
    location: data.location,
    image: data.image,
    meetingTime: data.meetingTime,
    contactInfo: data.contactInfo || data.owner,
    categories: data.categories || ['Other'],
  });
};

const addEvent = data => {
  console.log(`  Adding event: ${data.title}`);
  Events.collection.insert({
    eventID: data.eventID,
    title: data.title,
    description: data.description || '',
    date: normalizeDate(data.date),
    location: data.location,
    createdBy: data.createdBy,
    owner: data.createdBy,
    image: data.image || '/images/codingWorkshop.png',
  });
};

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

seedCollection(Clubs.collection, Meteor.settings.defaultClub, 'clubs', addClub);
seedCollection(Events.collection, Meteor.settings.defaultEvent, 'events', addEvent);
seedCollection(Interests.collection, Meteor.settings.defaultInterests, 'interests', addInterest);
syncDefaultProfiles();
seedProfileClubs();
seedEventClubs();
migrateClubSchedules();
