import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Clubs } from '../club/Club';
import { EventClubs } from '../events/EventClubs';
import { Events } from '../events/Events';
import { ProfileClubs } from '../profile/ProfileClubs';
import { Profiles } from '../profiles/Profiles';
import {
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

import { rankAdaptiveRecommendations, stripPrivateRecommendationFields } from './adaptiveRank';
import { recordRecommendationInteraction } from './interactionRecorder';

/* eslint-disable no-console */

const PUBLIC_LISTING_SELECTOR = {
  $or: [
    { publicationStatus: 'published' },
    { publicationStatus: { $exists: false } },
  ],
};

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

const logRecommendationRequest = document => {
  try {
    return RecommendationRequests.collection.insert(document);
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
  const clubsByNumber = new Map(Clubs.collection.find({}).fetch().map(club => [club.clubID, club._id]));
  return events.map(event => {
    const ids = byEvent.get(event._id) || [];
    const legacyId = clubsByNumber.get(event.eventID);
    if (legacyId && !ids.includes(legacyId)) {
      ids.push(legacyId);
    }
    return { ...event, _hostClubIds: ids };
  });
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
  const filters = compact({
    region: textOrUndefined(supplied.region, 80),
    pricePreference: textOrUndefined(supplied.pricePreference, 20),
    includePassed: supplied.includePassed === true ? true : undefined,
    includeJoined: supplied.includeJoined === true ? true : undefined,
  });
  return { kind, surface, limit, filters };
};

const runRecommendation = ({ userId, kind, surface, limit, filters }) => {
  const started = Date.now();
  const rawCandidates = kind === 'group'
    ? Clubs.collection.find(PUBLIC_LISTING_SELECTOR).fetch()
    : Events.collection.find(PUBLIC_LISTING_SELECTOR).fetch();
  const candidates = kind === 'group' ? rawCandidates : hostLinksFor(rawCandidates);
  const profile = Profiles.collection.findOne({ userId }) || null;
  const preferences = RecommendationPreferences.collection.findOne({ userId }) || null;
  const memberships = ProfileClubs.collection.find({ userId }).fetch();
  const interactions = RecommendationInteractions.collection.find({ userId }, {
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
  const expiresAt = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
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
    expiresAt,
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

const fallbackRecommendation = ({ userId, kind, surface, limit, filters, error }) => {
  const started = Date.now();
  const candidates = kind === 'group'
    ? Clubs.collection.find(PUBLIC_LISTING_SELECTOR).fetch()
    : hostLinksFor(Events.collection.find(PUBLIC_LISTING_SELECTOR).fetch());
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
    errorCode: `${error?.error || error?.message || 'ranking-failed'}`.slice(0, 120),
    expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
  });
  return {
    requestId,
    modelVersion: 'baseline_v1',
    selectedTier: 'baseline',
    capabilitySnapshot: fallback.capabilitySnapshot,
    fallbackUsed: true,
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
    try {
      return runRecommendation({ userId: this.userId, ...normalized });
    } catch (error) {
      console.error('[recommendations] adaptive ranking failed; using baseline:', error.message);
      return fallbackRecommendation({ userId: this.userId, ...normalized, error });
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
