import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { parseMeetingTime } from '../../api/club/schedule';

const addClubMethod = 'Clubs.insert';

const requireLoggedIn = (userId) => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'You must be signed in to do that.');
  }
};

const requireAdmin = (userId) => {
  requireLoggedIn(userId);
  if (!Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'You must be an administrator to do that.');
  }
};

const getUsername = (userId) => {
  const user = Meteor.users.findOne(userId);
  return user?.username || user?.emails?.[0]?.address || userId;
};

const normalizeCategories = categories => {
  if (!categories) {
    return ['Other'];
  }
  if (Array.isArray(categories)) {
    return categories.map(category => `${category}`.trim()).filter(Boolean);
  }
  return `${categories}`.split(',').map(category => category.trim()).filter(Boolean);
};

const toDate = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Meteor.Error('invalid-date', 'Please provide a valid event date.');
  }
  return date;
};

const parseNumericId = (value, label) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Meteor.Error('invalid-id', `Please provide a valid numeric ${label}.`);
  }
  return parsed;
};

const MAX_IMAGE_LENGTH = 2800000;

const checkImageSize = image => {
  if (image && image.length > MAX_IMAGE_LENGTH) {
    throw new Meteor.Error('image-too-large', 'Please choose a smaller image.');
  }
};

const normalizeTag = tag => `${tag}`.trim().replace(/\s+/g, ' ').slice(0, 28);

const normalizeSchedule = schedule => {
  if (!schedule || !Array.isArray(schedule.days) || schedule.days.length === 0) {
    return null;
  }
  const days = [...new Set(schedule.days.map(day => Number.parseInt(day, 10)).filter(day => day >= 0 && day <= 6))].sort();
  if (days.length === 0) {
    return null;
  }
  const time = /^\d{2}:\d{2}$/.test(schedule.time || '') ? schedule.time : '17:00';
  const cadence = schedule.cadence === 'biweekly' ? 'biweekly' : 'weekly';
  return { days, time, cadence };
};

const nextNumericId = (collection, field) => {
  const newest = collection.find({}, { sort: { [field]: -1 }, limit: 1 }).fetch()[0];
  return (newest?.[field] || 0) + 1;
};

const findClubByAnyId = clubId => {
  if (!clubId && clubId !== 0) {
    return null;
  }
  const direct = Clubs.collection.findOne(clubId);
  if (direct) {
    return direct;
  }
  const numericClubId = Number.parseInt(clubId, 10);
  if (!Number.isNaN(numericClubId)) {
    return Clubs.collection.findOne({ clubID: numericClubId });
  }
  return null;
};

Meteor.methods({
  createUserProfile(userId, email, firstName = '', lastName = '', interests = []) {
    check(userId, Match.Maybe(String));
    check(email, String);
    check(firstName, String);
    check(lastName, String);
    check(interests, Match.Optional([String]));

    const targetUserId = userId || this.userId;
    requireLoggedIn(targetUserId);

    if (this.userId !== targetUserId && !Roles.userIsInRole(this.userId, 'admin')) {
      throw new Meteor.Error('not-authorized', 'You can only create a profile for your own account.');
    }

    const existingProfile = Profiles.collection.findOne({ $or: [{ userId: targetUserId }, { email }] });
    const profileData = {
      userId: targetUserId,
      email,
      firstName,
      lastName,
      bio: existingProfile?.bio || '',
      title: existingProfile?.title || 'Student',
      picture: existingProfile?.picture || '/images/defaultprofilepic.png',
      interests: interests || [],
    };

    if (existingProfile) {
      Profiles.collection.update(existingProfile._id, { $set: profileData });
      return existingProfile._id;
    }

    return Profiles.collection.insert(profileData);
  },

  'Profiles.update'(profileData) {
    check(profileData, {
      firstName: String,
      lastName: String,
      email: String,
      bio: String,
      title: String,
      interests: Match.Optional([String]),
    });
    requireLoggedIn(this.userId);

    const profile = Profiles.collection.findOne({ userId: this.userId });
    if (!profile) {
      throw new Meteor.Error('profile-not-found', 'No profile exists for this account yet.');
    }

    Profiles.collection.update(profile._id, {
      $set: {
        firstName: profileData.firstName,
        lastName: profileData.lastName,
        email: profileData.email,
        bio: profileData.bio,
        title: profileData.title,
        interests: profileData.interests || [],
      },
    });
  },

  'Profiles.updatePicture'(picture) {
    check(picture, String);
    requireLoggedIn(this.userId);

    if (picture.length > 2500000) {
      throw new Meteor.Error('image-too-large', 'Please choose a smaller profile image.');
    }

    const validImage = picture.startsWith('data:image/') || picture.startsWith('/images/') || picture.startsWith('images/') || picture.startsWith('http');
    if (!validImage) {
      throw new Meteor.Error('invalid-image', 'Please choose a valid image file or image URL.');
    }

    Profiles.collection.update({ userId: this.userId }, { $set: { picture } });
  },

  'Profiles.remove'(profileId) {
    check(profileId, String);
    requireAdmin(this.userId);
    Profiles.collection.remove(profileId);
  },

  'Clubs.insert'(clubData) {
    check(clubData, {
      name: String,
      description: String,
      location: String,
      image: Match.Optional(String),
      meetingTime: String,
      contactInfo: Match.Optional(String),
      categories: Match.Optional(Match.OneOf(String, [String])),
      tags: Match.Optional([String]),
      schedule: Match.Optional(Object),
    });
    requireLoggedIn(this.userId);
    checkImageSize(clubData.image);

    const clubID = nextNumericId(Clubs.collection, 'clubID');
    return Clubs.collection.insert({
      clubID,
      name: clubData.name,
      owner: getUsername(this.userId),
      description: clubData.description,
      location: clubData.location,
      image: clubData.image || '/images/LogoCircle.png',
      meetingTime: clubData.meetingTime,
      contactInfo: clubData.contactInfo || getUsername(this.userId),
      categories: normalizeCategories(clubData.categories),
      tags: (clubData.tags || []).map(normalizeTag).filter(tag => tag.length >= 2).slice(0, 20),
      schedule: normalizeSchedule(clubData.schedule) || parseMeetingTime(clubData.meetingTime) || undefined,
    });
  },

  'Clubs.update'(clubId, clubData) {
    check(clubId, String);
    check(clubData, {
      clubID: Match.Optional(Match.OneOf(Number, String)),
      name: String,
      owner: String,
      description: String,
      location: String,
      image: Match.Optional(String),
      meetingTime: String,
      contactInfo: Match.Optional(String),
      categories: Match.Optional(Match.OneOf(String, [String])),
      tags: Match.Optional([String]),
      schedule: Match.Optional(Object),
    });
    requireAdmin(this.userId);

    Clubs.collection.update(clubId, {
      $set: {
        name: clubData.name,
        owner: clubData.owner,
        description: clubData.description,
        location: clubData.location,
        image: clubData.image || '/images/LogoCircle.png',
        meetingTime: clubData.meetingTime,
        contactInfo: clubData.contactInfo || '',
        categories: normalizeCategories(clubData.categories),
        ...(clubData.tags ? { tags: clubData.tags.map(normalizeTag).filter(tag => tag.length >= 2).slice(0, 20) } : {}),
      },
    });

    // Explicit schedule wins; otherwise re-derive from the (possibly edited) meeting
    // text — and clear it when the text no longer describes a recurring meeting.
    const derived = normalizeSchedule(clubData.schedule) || parseMeetingTime(clubData.meetingTime);
    if (derived) {
      Clubs.collection.update(clubId, { $set: { schedule: derived } });
    } else {
      Clubs.collection.update(clubId, { $unset: { schedule: '' } });
    }
  },

  'Clubs.remove'(clubId) {
    check(clubId, String);
    requireAdmin(this.userId);
    Clubs.collection.remove(clubId);
    ProfileClubs.collection.remove({ clubId });
    EventClubs.collection.remove({ clubId });
  },

  'profileClubs.add'(clubId) {
    check(clubId, Match.OneOf(String, Number));
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }

    const existing = ProfileClubs.collection.findOne({ userId: this.userId, clubId: club._id });
    if (existing) {
      return existing._id;
    }

    return ProfileClubs.collection.insert({
      userId: this.userId,
      clubId: club._id,
      createdAt: new Date(),
    });
  },

  'profileClubs.remove'(clubId) {
    check(clubId, Match.OneOf(String, Number));
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubId);
    const normalizedClubId = club?._id || clubId;
    ProfileClubs.collection.remove({ userId: this.userId, clubId: normalizedClubId });
  },

  'Events.insert'(eventData) {
    check(eventData, {
      eventID: Match.OneOf(Number, String),
      title: String,
      description: Match.Optional(String),
      date: Match.OneOf(Date, String),
      location: String,
      createdBy: Match.Optional(String),
      image: Match.Optional(String),
    });
    requireLoggedIn(this.userId);
    checkImageSize(eventData.image);

    const hostClubID = parseNumericId(eventData.eventID, 'host club ID');
    const eventId = Events.collection.insert({
      eventID: hostClubID,
      title: eventData.title,
      description: eventData.description || '',
      date: toDate(eventData.date),
      location: eventData.location,
      createdBy: eventData.createdBy || getUsername(this.userId),
      owner: getUsername(this.userId),
      image: eventData.image || '/images/codingWorkshop.png',
    });

    const hostClub = findClubByAnyId(hostClubID);
    if (hostClub) {
      EventClubs.collection.insert({ clubId: hostClub._id, eventId, userId: this.userId, createdAt: new Date() });
    }

    return eventId;
  },

  'Events.update'(eventId, eventData) {
    check(eventId, String);
    check(eventData, {
      eventID: Match.OneOf(Number, String),
      title: String,
      description: Match.Optional(String),
      date: Match.OneOf(Date, String),
      location: String,
      createdBy: String,
      image: Match.Optional(String),
    });
    requireAdmin(this.userId);

    const hostClubID = parseNumericId(eventData.eventID, 'host club ID');
    Events.collection.update(eventId, {
      $set: {
        eventID: hostClubID,
        title: eventData.title,
        description: eventData.description || '',
        date: toDate(eventData.date),
        location: eventData.location,
        createdBy: eventData.createdBy,
        image: eventData.image || '/images/codingWorkshop.png',
      },
    });

    EventClubs.collection.remove({ eventId });
    const hostClub = findClubByAnyId(hostClubID);
    if (hostClub) {
      EventClubs.collection.insert({ clubId: hostClub._id, eventId, userId: this.userId, createdAt: new Date() });
    }
  },

  'Events.remove'(eventId) {
    check(eventId, String);
    requireAdmin(this.userId);
    Events.collection.remove(eventId);
    EventClubs.collection.remove({ eventId });
  },

  'eventSwipes.record'(eventId, decision, kind = 'event') {
    check(eventId, String);
    check(decision, String);
    check(kind, String);
    requireLoggedIn(this.userId);

    if (!['interested', 'passed'].includes(decision)) {
      throw new Meteor.Error('invalid-decision', 'A swipe decision must be either "interested" or "passed".');
    }
    if (!['event', 'club'].includes(kind)) {
      throw new Meteor.Error('invalid-kind', 'A swipe is on either an event or a club.');
    }

    // Only the server can authoritatively check existence; a client stub may
    // simply not have the record cached, which should not block the call.
    if (Meteor.isServer) {
      const collection = kind === 'club' ? Clubs.collection : Events.collection;
      if (!collection.findOne(eventId)) {
        throw new Meteor.Error('not-found', 'That listing could not be found.');
      }
    }

    const existing = EventSwipes.collection.findOne({ userId: this.userId, eventId });
    if (existing) {
      EventSwipes.collection.update(existing._id, { $set: { decision, kind, createdAt: new Date() } });
      return existing._id;
    }

    return EventSwipes.collection.insert({
      userId: this.userId,
      eventId,
      decision,
      kind,
      createdAt: new Date(),
    });
  },

  'eventSwipes.remove'(eventId) {
    check(eventId, String);
    requireLoggedIn(this.userId);
    EventSwipes.collection.remove({ userId: this.userId, eventId });
  },

  'eventSwipes.clearPassed'() {
    requireLoggedIn(this.userId);
    EventSwipes.collection.remove({ userId: this.userId, decision: 'passed' });
  },

  'friends.request'(receiverId) {
    check(receiverId, String);
    requireLoggedIn(this.userId);

    if (receiverId === this.userId) {
      throw new Meteor.Error('invalid-friend', 'You cannot friend yourself.');
    }
    if (Meteor.isServer && !Meteor.users.findOne(receiverId)) {
      throw new Meteor.Error('user-not-found', 'That user could not be found.');
    }
    const existing = Friends.collection.findOne({
      $or: [
        { requesterId: this.userId, receiverId },
        { requesterId: receiverId, receiverId: this.userId },
      ],
    });
    if (existing) {
      return existing._id;
    }
    return Friends.collection.insert({
      requesterId: this.userId,
      receiverId,
      pairKey: [this.userId, receiverId].sort().join(':'),
      status: 'pending',
      createdAt: new Date(),
    });
  },

  'friends.accept'(edgeId) {
    check(edgeId, String);
    requireLoggedIn(this.userId);

    const edge = Friends.collection.findOne(edgeId);
    if (!edge || edge.receiverId !== this.userId) {
      throw new Meteor.Error('not-authorized', 'Only the request receiver can accept it.');
    }
    Friends.collection.update(edgeId, { $set: { status: 'accepted', respondedAt: new Date() } });
  },

  'friends.decline'(edgeId) {
    check(edgeId, String);
    requireLoggedIn(this.userId);

    const edge = Friends.collection.findOne(edgeId);
    if (!edge || edge.receiverId !== this.userId) {
      throw new Meteor.Error('not-authorized', 'Only the request receiver can decline it.');
    }
    Friends.collection.remove(edgeId);
  },

  'friends.remove'(otherUserId) {
    check(otherUserId, String);
    requireLoggedIn(this.userId);

    Friends.collection.remove({
      $or: [
        { requesterId: this.userId, receiverId: otherUserId },
        { requesterId: otherUserId, receiverId: this.userId },
      ],
    });
  },

  'clubs.addTag'(clubId, tag) {
    check(clubId, String);
    check(tag, String);
    requireLoggedIn(this.userId);

    const clean = normalizeTag(tag);
    if (clean.length < 2) {
      throw new Meteor.Error('invalid-tag', 'Tags need at least 2 characters.');
    }
    const club = Clubs.collection.findOne(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    // Server-only: the client cache does not always contain membership docs.
    if (Meteor.isServer) {
      const isMember = ProfileClubs.collection.findOne({ userId: this.userId, clubId });
      if (!isMember && !Roles.userIsInRole(this.userId, 'admin')) {
        throw new Meteor.Error('not-a-member', 'Join the club to add tags.');
      }
    }
    const tags = club.tags || [];
    const taken = [...tags, ...(club.categories || [])];
    if (taken.some(existing => `${existing}`.toLowerCase() === clean.toLowerCase())) {
      return;
    }
    if (tags.length >= 20) {
      throw new Meteor.Error('too-many-tags', 'This club already has 20 tags.');
    }
    Clubs.collection.update(clubId, { $push: { tags: clean } });
  },

  'clubs.removeTag'(clubId, tag) {
    check(clubId, String);
    check(tag, String);
    requireLoggedIn(this.userId);

    const club = Clubs.collection.findOne(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    const isOwner = club.owner === getUsername(this.userId);
    if (!isOwner && !Roles.userIsInRole(this.userId, 'admin')) {
      throw new Meteor.Error('not-authorized', 'Only the club owner or an admin can remove tags.');
    }
    Clubs.collection.update(clubId, { $pull: { tags: tag } });
  },

  'Clubs.organizeEvent'({ clubID, eventID }) {
    check(clubID, Match.OneOf(Number, String));
    check(eventID, String);
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubID);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    const exists = EventClubs.collection.findOne({ clubId: club._id, eventId: eventID });
    if (exists) {
      return exists._id;
    }
    return EventClubs.collection.insert({ clubId: club._id, eventId: eventID, userId: this.userId, createdAt: new Date() });
  },
});

export { addClubMethod };
