import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Clubs } from '../club/Club';
import { EventClubs } from '../events/EventClubs';
import { Events } from '../events/Events';
import { ProfileClubs } from '../profile/ProfileClubs';
import { Profiles } from '../profiles/Profiles';
import { retentionDays } from '../retention/retention';
import {
  PUBLIC_LISTING_SELECTOR,
  PUBLISHED_SELECTOR,
  WITHHELD_LISTING_FIELDS,
  eventWindow,
  eventsWithin,
  isOpenToAll,
} from '../listing/audience';
import {
  CLIENT_RECORDABLE_ACTIONS,
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_ENTITY_TYPES,
  RecommendationEmbeddings,
  RecommendationEntities,
  RecommendationFeatureSnapshots,
  RecommendationGraphEdges,
  RecommendationInteractions,
  RecommendationModelVersions,
  RecommendationPreferences,
  RecommendationRequests,
} from './RecommendationData';

import { RANKING_ACTIONS, rankAdaptiveRecommendations, stripPrivateRecommendationFields } from './adaptiveRank';
import { recordRecommendationInteraction } from './interactionRecorder';
import { interactionRecordingEnabled, recommendationsEnabled } from './recommendationSettings';

/* eslint-disable no-console */

const requireLoggedIn = userId => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'You must be signed in to do that.');
  }
};

const ensureChoice = (value, allowed, code, message) => {
  if (!allowed.includes(value)) {
    throw new Meteor.Error(code, message);
  }
};

const finiteOrUndefined = value => (
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? undefined
    : Number(value)
);

const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const textOrUndefined = (value, max = 120) => (
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
);

const PREFERENCE_FIELDS = [
  'topicIds',
  'preferredDays',
  'preferredTimeWindows',
  'travelRadiusMiles',
  'searchCenter',
  'pricePreference',
  'socialAtmospheres',
  'groupSizePreference',
  'accessibilityRequirements',
  'attendanceMode',
  'preferenceStrengths',
  'privacy',
];

/**
 * The request log is behaviour too — who asked for recommendations, when, on
 * which surface — so it stops with the rest of the log and expires on the same
 * schedule. With no request id the pages send no impressions, opens or flips
 * either (each needs the request it belongs to), so one switch quiets the
 * whole pipeline rather than leaving the browsers calling into a refusal.
 */
const logRecommendationRequest = document => {
  if (!interactionRecordingEnabled()) {
    return null;
  }
  try {
    return RecommendationRequests.collection.insert({
      ...document,
      expiresAt: new Date(Date.now() + retentionDays('behaviourDays') * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    // Ranking is the product path; observability is important but may not turn
    // a usable baseline into an outage if its own write fails.
    console.error('[recommendations] request logging failed:', error.message);
    return null;
  }
};

const itemExists = (entityType, entityId) => {
  if (entityType === 'event') {
    return Boolean(Events.collection.findOne(entityId));
  }
  if (entityType === 'group') {
    return Boolean(Clubs.collection.findOne(entityId));
  }
  if (entityType === 'user') {
    return Boolean(Meteor.users.findOne(entityId));
  }
  return Boolean(RecommendationEntities.collection.findOne(entityId));
};

const hostLinksFor = events => {
  const eventIds = events.map(event => event._id);
  const byEvent = new Map();
  EventClubs.collection.find({ eventId: { $in: eventIds } }).forEach(link => {
    const ids = byEvent.get(link.eventId) || [];
    ids.push(link.clubId);
    byEvent.set(link.eventId, ids);
  });
  // Only the groups these events name, and only the number: this used to fetch
  // every group whole, photo and all, on every call, to read one integer.
  const hostNumbers = [...new Set(events.map(event => event.eventID).filter(Number.isInteger))];
  const clubsByNumber = new Map(Clubs.collection
    .find({ clubID: { $in: hostNumbers } }, { fields: { clubID: 1 } })
    .map(club => [club.clubID, club._id]));
  return events.map(event => {
    const ids = byEvent.get(event._id) || [];
    const legacyId = clubsByNumber.get(event.eventID);
    if (legacyId && !ids.includes(legacyId)) {
      ids.push(legacyId);
    }
    return { ...event, _hostClubIds: ids };
  });
};

const membershipsOf = userId => ProfileClubs.collection.find({ userId }).fetch();

/**
 * The host numbers of the groups a person is in, which is what "hosted by a
 * group they belong to" is asked against.
 *
 * The host is the group an event NAMES, in its own `eventID`, and never a row
 * in EventClubs. It used to be either, and the row was a way in: for a long
 * while 'Clubs.organizeEvent' wrote one for anybody signed in, between any
 * group and any event, so a stranger could link a group of their own to a
 * private event and be dealt it. The method asks who is calling now. The rows
 * it wrote before are still there, and a rule that is safe only while every
 * writer of a collection stays careful is the rule that failed here. The
 * number is written by whoever posts the event and by the people who may edit
 * it, which is why the privacy methods trust it and nothing weaker.
 *
 * Published groups only: belonging to an archived group opens nothing. A
 * group with no number is left out, because `eventID: undefined` in a selector
 * would match every event that lacks one.
 */
const joinedHostNumbers = memberships => Clubs.collection
  .find(
    { $and: [{ _id: { $in: memberships.map(membership => membership.clubId) } }, PUBLISHED_SELECTOR] },
    { fields: { clubID: 1 } },
  )
  .map(club => club.clubID)
  .filter(Number.isInteger);

/**
 * Which listings may be ranked for one person, as a Mongo selector.
 *
 * Public ones, and the ones they are inside: a private group they belong to,
 * a private event hosted by a group they belong to. It is the publications'
 * rule, from the same definitions (listing/audience.js), and for the same
 * reason. What this method returns is sent to the browser as surely as a
 * subscription is, and a private hike dealt into a stranger's deck is
 * published, whatever the publications do.
 *
 * Events are held to the window the public event publication uses by default,
 * today and the months after it, so the deck and the wall are choosing from
 * the same events. Both paths used to load every published event there had
 * ever been on every call, most of them long over, and leave the ranker to
 * throw them away one at a time.
 */
export const recommendationCandidateSelector = ({
  userId,
  kind,
  memberships = membershipsOf(userId),
  hostNumbers = kind === 'group' ? [] : joinedHostNumbers(memberships),
}) => {
  const insideOrPublic = inside => ({ $or: [PUBLIC_LISTING_SELECTOR, { $and: [PUBLISHED_SELECTOR, inside] }] });
  if (kind === 'group') {
    return insideOrPublic({ _id: { $in: memberships.map(membership => membership.clubId) } });
  }
  return { $and: [insideOrPublic({ eventID: { $in: hostNumbers } }), eventsWithin(eventWindow())] };
};

/**
 * The candidates themselves, without the fields no listing is sent with. The
 * ranker's output goes to the browser nearly whole, and until now that was
 * every field but `owner`: `createdBy`, the same address again, and the invite
 * link of any group that has one.
 *
 * The ranker refuses anything not public unless it is marked as visible to
 * this caller, and the mark is the second lock, so it is worked out again
 * here from the memberships rather than taken from the selector's word: a
 * selector loosened by mistake lets private listings in, and they arrive
 * without it.
 *
 * For an event the mark reads the host it names and not `_hostClubIds`. Those
 * are gathered from the link rows as well, for the ranker to score with, and
 * a lock that reads a row anybody can write repeats the first lock's mistake
 * instead of checking it.
 */
export const recommendationCandidates = ({ userId, kind, memberships = membershipsOf(userId) }) => {
  const source = kind === 'group' ? Clubs : Events;
  const hostNumbers = kind === 'group' ? [] : joinedHostNumbers(memberships);
  const found = source.collection
    .find(
      recommendationCandidateSelector({ userId, kind, memberships, hostNumbers }),
      { fields: WITHHELD_LISTING_FIELDS },
    )
    .fetch();
  const joinedIds = new Set(memberships.map(membership => membership.clubId));
  const joinedNumbers = new Set(hostNumbers);
  const inside = kind === 'group'
    ? candidate => joinedIds.has(candidate._id)
    : candidate => joinedNumbers.has(candidate.eventID);
  return (kind === 'group' ? found : hostLinksFor(found)).map(candidate => (
    !isOpenToAll(candidate) && inside(candidate) ? { ...candidate, _visibleToCaller: true } : candidate
  ));
};

const loadModelInputs = ({ userId, entityType, candidateIds }) => {
  const models = RecommendationModelVersions.collection.find({ status: 'active' }).fetch();
  const modelVersions = models.map(model => model.version);
  const entityIds = [userId, ...candidateIds];
  const embeddings = modelVersions.length === 0 ? [] : RecommendationEmbeddings.collection.find({
    modelVersion: { $in: modelVersions },
    entityId: { $in: entityIds },
    entityType: { $in: ['user', entityType] },
  }).fetch();
  const featureSnapshots = RecommendationFeatureSnapshots.collection.find({
    entityType,
    entityId: { $in: candidateIds },
  }, { sort: { asOf: -1 }, limit: candidateIds.length * 3 }).fetch();
  return { models, embeddings, featureSnapshots };
};

const recommendationOptions = options => {
  const kind = options?.kind === 'group' ? 'group' : 'event';
  const surface = `${options?.surface || 'feed'}`.slice(0, 40);
  const limit = Math.max(1, Math.min(100, Number(options?.limit) || 20));
  const supplied = options?.filters && typeof options.filters === 'object' && !Array.isArray(options.filters)
    ? options.filters
    : {};
  // Holding back an event the person is going to is the deck's rule: a card
  // that has been answered is not dealt again. Applied to every surface it took
  // the card off the Discover wall's ranked list as well. The wall refetches
  // after each swipe and sorts anything without a position below everything
  // that has one, so tapping "I'm going" sent the card under up to a hundred
  // others, out from beneath the person's thumb. A wall shows what is on; being
  // on someone's calendar does not make an event less on.
  const holdsBackGoing = surface === 'swipe_deck' && supplied.includeGoing !== true;
  const filters = compact({
    region: textOrUndefined(supplied.region, 80),
    pricePreference: textOrUndefined(supplied.pricePreference, 20),
    includePassed: supplied.includePassed === true ? true : undefined,
    includeGoing: holdsBackGoing ? undefined : true,
    includeJoined: supplied.includeJoined === true ? true : undefined,
  });
  return { kind, surface, limit, filters };
};

const runRecommendation = ({ userId, kind, surface, limit, filters }) => {
  const started = Date.now();
  const memberships = membershipsOf(userId);
  const candidates = recommendationCandidates({ userId, kind, memberships });
  const profile = Profiles.collection.findOne({ userId }) || null;
  const preferences = RecommendationPreferences.collection.findOne({ userId }) || null;
  const interactions = RecommendationInteractions.collection.find({
    userId,
    action: { $in: RANKING_ACTIONS },
  }, {
    sort: { occurredAt: -1 },
    limit: 1000,
  }).fetch();
  const graphEdges = RecommendationGraphEdges.collection.find({
    fromType: 'user',
    fromId: userId,
    privacyEligibility: { $ne: 'excluded' },
  }, { sort: { occurredAt: -1 }, limit: 2000 }).fetch();
  const entityType = kind === 'group' ? 'group' : 'event';
  const modelInputs = loadModelInputs({
    userId,
    entityType,
    candidateIds: candidates.map(candidate => candidate._id),
  });
  const settings = Meteor.settings.recommendations || {};
  const result = rankAdaptiveRecommendations({
    candidates,
    kind,
    userId,
    profile,
    preferences,
    memberships,
    interactions,
    graphEdges,
    models: modelInputs.models,
    embeddings: modelInputs.embeddings,
    featureSnapshots: modelInputs.featureSnapshots,
    filters,
    weights: settings.weights,
    limit,
  });
  const requestId = logRecommendationRequest({
    userId,
    surface,
    requestedAt: new Date(),
    modelVersion: settings.activeModel || 'adaptive_v1',
    selectedTier: result.selectedTier,
    availableComponents: result.capabilitySnapshot.availableComponents,
    candidateCount: result.candidateCount,
    returnedCount: result.items.length,
    filterContext: filters,
    capabilitySnapshot: result.capabilitySnapshot,
    fallbackUsed: false,
    latencyMs: Math.max(0, Date.now() - started),
  });
  return {
    requestId,
    modelVersion: settings.activeModel || 'adaptive_v1',
    selectedTier: result.selectedTier,
    capabilitySnapshot: result.capabilitySnapshot,
    fallbackUsed: false,
    items: result.items.map((item, position) => ({
      ...stripPrivateRecommendationFields(item),
      position,
    })),
  };
};

/**
 * The baseline on its own: upcoming, complete, recently added. It reads the
 * listings and nothing from the recommendation collections, which is what
 * makes it safe to fall back to when those are the thing that is wrong — and
 * what makes it the right answer when recommendations are switched off.
 *
 * `fallbackReason` is how a caller tells the two apart: 'disabled' is an
 * operator's decision and not an error; 'ranking-failed' is one.
 *
 * The candidates are chosen exactly as they are for the adaptive path. Who may
 * be shown a listing is not a ranking feature, and must not be one of the
 * things that goes away when ranking does.
 */
const fallbackRecommendation = ({ userId, kind, surface, limit, filters, reason, error }) => {
  const started = Date.now();
  const candidates = recommendationCandidates({ userId, kind });
  const fallback = rankAdaptiveRecommendations({ candidates, kind, userId, filters, limit });
  const requestId = logRecommendationRequest({
    userId,
    surface,
    requestedAt: new Date(),
    modelVersion: 'baseline_v1',
    selectedTier: 'baseline',
    availableComponents: ['baseline'],
    candidateCount: fallback.candidateCount,
    returnedCount: fallback.items.length,
    filterContext: filters,
    capabilitySnapshot: fallback.capabilitySnapshot,
    fallbackUsed: true,
    latencyMs: Math.max(0, Date.now() - started),
    errorCode: `${error?.error || error?.message || reason}`.slice(0, 120),
  });
  return {
    requestId,
    modelVersion: 'baseline_v1',
    selectedTier: 'baseline',
    capabilitySnapshot: fallback.capabilitySnapshot,
    fallbackUsed: true,
    fallbackReason: reason,
    items: fallback.items.map((item, position) => ({
      ...stripPrivateRecommendationFields(item),
      position,
    })),
  };
};

Meteor.methods({
  'recommendations.get'(options = {}) {
    check(options, Object);
    requireLoggedIn(this.userId);
    const normalized = recommendationOptions(options);
    if (!Meteor.isServer) {
      return null;
    }
    // The launch-day escape hatch: `recommendations.enabled: false` in the
    // settings. Every page already copes with this answer, because it is the
    // one they get when ranking throws.
    if (!recommendationsEnabled()) {
      return fallbackRecommendation({ userId: this.userId, ...normalized, reason: 'disabled' });
    }
    try {
      return runRecommendation({ userId: this.userId, ...normalized });
    } catch (error) {
      console.error('[recommendations] adaptive ranking failed; using baseline:', error.message);
      return fallbackRecommendation({ userId: this.userId, ...normalized, reason: 'ranking-failed', error });
    }
  },

  'recommendationInteractions.record'(payload) {
    check(payload, Object);
    requireLoggedIn(this.userId);
    check(payload.entityType, String);
    check(payload.entityId, String);
    check(payload.action, String);
    check(payload.clientEventId, String);
    if (!payload.clientEventId.trim()) {
      throw new Meteor.Error('invalid-client-event-id', 'Each interaction needs an idempotency key.');
    }
    ensureChoice(
      payload.entityType,
      RECOMMENDATION_ENTITY_TYPES,
      'invalid-entity-type',
      'That recommendation entity type is not supported.',
    );
    ensureChoice(
      payload.action,
      RECOMMENDATION_ACTIONS,
      'invalid-action',
      'That recommendation action is not supported.',
    );
    // A real action, but not one a browser gets to assert: an RSVP, a join or
    // a verified attendance is recorded by the server method that makes it
    // true. See CLIENT_RECORDABLE_ACTIONS.
    if (!CLIENT_RECORDABLE_ACTIONS.includes(payload.action)) {
      throw new Meteor.Error('not-authorized', 'MatchBook records that itself, when it happens.');
    }
    if (!Meteor.isServer) {
      return payload.clientEventId;
    }
    if (!itemExists(payload.entityType, payload.entityId)) {
      throw new Meteor.Error('not-found', 'That recommendation item could not be found.');
    }
    const request = payload.requestId
      ? RecommendationRequests.collection.findOne({ _id: payload.requestId, userId: this.userId })
      : null;
    if (payload.action === 'impression' && !request) {
      throw new Meteor.Error('invalid-request', 'A visible impression needs its recommendation request.');
    }
    const rawPosition = finiteOrUndefined(payload.position);
    const position = Number.isInteger(rawPosition) && rawPosition >= 0 ? rawPosition : undefined;
    if (payload.action === 'impression' && (!Number.isInteger(position) || position < 0)) {
      throw new Meteor.Error('invalid-position', 'A visible impression needs a non-negative card position.');
    }
    const selectionPropensity = finiteOrUndefined(payload.selectionPropensity);
    const context = compact({
      exploratory: payload.exploratory === undefined ? undefined : Boolean(payload.exploratory),
      selectionPropensity: selectionPropensity === undefined
        ? undefined
        : Math.max(0, Math.min(1, selectionPropensity)),
    });
    return recordRecommendationInteraction({
      userId: this.userId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      action: payload.action,
      clientEventId: payload.clientEventId.slice(0, 160),
      sessionId: textOrUndefined(payload.sessionId, 160),
      requestId: request?._id,
      surface: request?.surface || textOrUndefined(payload.surface, 40),
      position,
      displaySize: ['standard', 'large', 'featured'].includes(payload.displaySize)
        ? payload.displaySize
        : undefined,
      modelVersion: request?.modelVersion,
      selectedTier: request?.selectedTier,
      componentsUsed: request?.availableComponents,
      dwellMs: (() => {
        const value = finiteOrUndefined(payload.dwellMs);
        return Number.isInteger(value) && value >= 0 ? value : undefined;
      })(),
      context,
      predecessorId: textOrUndefined(payload.predecessorId, 160),
      source: 'user',
    });
  },

  'recommendationPreferences.update'(payload) {
    check(payload, Object);
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return null;
    }
    const fields = compact({
      topicIds: payload.topicIds === null ? undefined : payload.topicIds,
      preferredDays: payload.preferredDays === null ? undefined : payload.preferredDays,
      preferredTimeWindows: payload.preferredTimeWindows === null ? undefined : payload.preferredTimeWindows,
      travelRadiusMiles: payload.travelRadiusMiles === null
        ? undefined
        : finiteOrUndefined(payload.travelRadiusMiles),
      searchCenter: payload.searchCenter === null ? undefined : payload.searchCenter,
      pricePreference: payload.pricePreference === null ? undefined : payload.pricePreference,
      socialAtmospheres: payload.socialAtmospheres === null ? undefined : payload.socialAtmospheres,
      groupSizePreference: payload.groupSizePreference === null ? undefined : payload.groupSizePreference,
      accessibilityRequirements: payload.accessibilityRequirements === null
        ? undefined
        : payload.accessibilityRequirements,
      attendanceMode: payload.attendanceMode === null ? undefined : payload.attendanceMode,
      preferenceStrengths: payload.preferenceStrengths === null ? undefined : payload.preferenceStrengths,
      privacy: payload.privacy === null ? undefined : payload.privacy,
      updatedAt: new Date(),
    });
    const unset = Object.fromEntries(Object.entries(payload)
      .filter(([key, value]) => PREFERENCE_FIELDS.includes(key) && value === null)
      .map(([key]) => [key, '']));
    const modifier = {
      $set: fields,
      $setOnInsert: { createdAt: new Date() },
    };
    if (Object.keys(unset).length > 0) {
      modifier.$unset = unset;
    }
    RecommendationPreferences.collection.upsert({ userId: this.userId }, modifier);
    return RecommendationPreferences.collection.findOne({ userId: this.userId })?._id;
  },
});

export const recommendationMethodNames = [
  'recommendations.get',
  'recommendationInteractions.record',
  'recommendationPreferences.update',
];
