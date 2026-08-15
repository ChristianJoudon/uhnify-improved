import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/* eslint-disable no-console */

/**
 * The recommendation data plane.
 *
 * These collections exist before every model does. Advanced fields are
 * optional by design: absent data means "this component is unavailable", not
 * "the request is invalid". Source collections such as Events, Clubs,
 * Profiles, Friends, and ProfileClubs remain the product source of truth. This
 * layer records behavioral history, materialized state, graph projections,
 * feature/model artifacts, and the evidence needed to evaluate later tiers.
 */

export const RECOMMENDATION_ENTITY_TYPES = [
  'user',
  'event',
  'group',
  'organizer',
  'venue',
  'topic',
  'series',
];

export const RECOMMENDATION_ACTIONS = [
  'impression',
  'opened',
  'flipped',
  'interested',
  'passed',
  'saved',
  'unsaved',
  'rsvp_going',
  'rsvp_maybe',
  'rsvp_canceled',
  'attendance_self_reported',
  'attendance_verified',
  'attendance_removed',
  'joined_group',
  'left_group',
  'followed_group',
  'unfollowed_group',
  'calendar_added',
  'undo',
  'correction',
];

export const RECOMMENDATION_TIERS = [
  'baseline',
  'content',
  'hybrid',
  'collaborative',
  'heterogeneous',
  'temporal',
];

export const GRAPH_RELATIONS = [
  'accepted_friend',
  'joined_group',
  'followed_group',
  'hosts',
  'has_topic',
  'occurs_at',
  'belongs_to_series',
  'viewed',
  'opened',
  'interested',
  'passed',
  'saved',
  'rsvp_going',
  'attended',
];

const indexAtStartup = (collection, label, indexes) => {
  if (!Meteor.isServer) {
    return;
  }
  Meteor.startup(() => {
    indexes.forEach(({ keys, options = {} }) => {
      collection.rawCollection().createIndex(keys, options).catch(error => {
        // Index failures change correctness as well as speed, so never hide one.
        console.error(`[index] ${label} failed:`, error.message);
      });
    });
  });
};

const defineCollection = ({ name, schema, indexes = [] }) => {
  const collection = new Mongo.Collection(name);
  collection.attachSchema(schema);
  indexAtStartup(collection, name, indexes);
  return { name, collection, schema };
};

export const RecommendationInteractions = defineCollection({
  name: 'RecommendationInteractions',
  schema: new SimpleSchema({
    userId: String,
    entityType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    entityId: String,
    action: { type: String, allowedValues: RECOMMENDATION_ACTIONS },
    // Imported history may genuinely lack an action timestamp. Temporal
    // components must abstain from that row rather than learn from a guess.
    occurredAt: { type: Date, optional: true },
    clientEventId: { type: String, optional: true },
    sessionId: { type: String, optional: true },
    requestId: { type: String, optional: true },
    surface: { type: String, optional: true },
    position: { type: SimpleSchema.Integer, min: 0, optional: true },
    displaySize: {
      type: String,
      allowedValues: ['standard', 'large', 'featured'],
      optional: true,
    },
    modelVersion: { type: String, optional: true },
    selectedTier: {
      type: String,
      allowedValues: RECOMMENDATION_TIERS,
      optional: true,
    },
    componentsUsed: { type: Array, optional: true },
    'componentsUsed.$': String,
    dwellMs: { type: SimpleSchema.Integer, min: 0, optional: true },
    context: { type: Object, blackbox: true, optional: true },
    predecessorId: { type: String, optional: true },
    source: {
      type: String,
      allowedValues: ['user', 'system', 'import', 'migration', 'legacy'],
      optional: true,
    },
    createdAt: Date,
  }),
  indexes: [
    {
      keys: { userId: 1, clientEventId: 1 },
      options: { unique: true, sparse: true },
    },
    { keys: { userId: 1, occurredAt: -1 } },
    { keys: { userId: 1, entityType: 1, entityId: 1, occurredAt: -1 } },
    { keys: { entityType: 1, entityId: 1, occurredAt: -1 } },
    { keys: { requestId: 1, position: 1 } },
  ],
});

export const UserItemStates = defineCollection({
  name: 'RecommendationUserItemStates',
  schema: new SimpleSchema({
    userId: String,
    entityType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    entityId: String,
    interestState: {
      type: String,
      allowedValues: ['neutral', 'interested', 'passed'],
      optional: true,
    },
    saved: { type: Boolean, optional: true },
    rsvpStatus: {
      type: String,
      allowedValues: ['going', 'maybe', 'canceled'],
      optional: true,
    },
    attendanceStatus: {
      type: String,
      allowedValues: ['none', 'self_reported', 'verified'],
      optional: true,
    },
    joined: { type: Boolean, optional: true },
    followed: { type: Boolean, optional: true },
    firstInteractionAt: { type: Date, optional: true },
    lastInteractionAt: { type: Date, optional: true },
    lastMeaningfulAction: { type: String, optional: true },
    lastRequestId: { type: String, optional: true },
    signalCounts: { type: Object, blackbox: true, optional: true },
    updatedAt: Date,
  }),
  indexes: [
    {
      keys: { userId: 1, entityType: 1, entityId: 1 },
      options: { unique: true },
    },
    { keys: { userId: 1, lastInteractionAt: -1 } },
  ],
});

export const RecommendationRequests = defineCollection({
  name: 'RecommendationRequests',
  schema: new SimpleSchema({
    userId: String,
    surface: String,
    requestedAt: Date,
    modelVersion: String,
    selectedTier: { type: String, allowedValues: RECOMMENDATION_TIERS },
    availableComponents: { type: Array, optional: true },
    'availableComponents.$': String,
    candidateCount: { type: SimpleSchema.Integer, min: 0 },
    returnedCount: { type: SimpleSchema.Integer, min: 0 },
    filterContext: { type: Object, blackbox: true, optional: true },
    capabilitySnapshot: { type: Object, blackbox: true, optional: true },
    fallbackUsed: Boolean,
    latencyMs: { type: SimpleSchema.Integer, min: 0 },
    experimentKey: { type: String, optional: true },
    variant: { type: String, optional: true },
    errorCode: { type: String, optional: true },
    expiresAt: { type: Date, optional: true },
  }),
  indexes: [
    { keys: { userId: 1, requestedAt: -1 } },
    { keys: { modelVersion: 1, requestedAt: -1 } },
    { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ],
});

export const RecommendationImpressions = defineCollection({
  name: 'RecommendationImpressions',
  schema: new SimpleSchema({
    requestId: String,
    userId: String,
    entityType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    entityId: String,
    position: { type: SimpleSchema.Integer, min: 0 },
    surface: String,
    displaySize: {
      type: String,
      allowedValues: ['standard', 'large', 'featured'],
      optional: true,
    },
    modelVersion: String,
    selectedTier: { type: String, allowedValues: RECOMMENDATION_TIERS },
    componentsUsed: { type: Array, optional: true },
    'componentsUsed.$': String,
    shownAt: Date,
    exploratory: { type: Boolean, optional: true },
    selectionPropensity: { type: Number, min: 0, max: 1, optional: true },
    scoreSnapshot: { type: Object, blackbox: true, optional: true },
    clientEventId: { type: String, optional: true },
    createdAt: Date,
  }),
  indexes: [
    {
      keys: { userId: 1, clientEventId: 1 },
      options: { unique: true, sparse: true },
    },
    { keys: { requestId: 1, position: 1 } },
    { keys: { userId: 1, entityType: 1, entityId: 1, shownAt: -1 } },
  ],
});

export const RecommendationPreferences = defineCollection({
  name: 'RecommendationPreferences',
  schema: new SimpleSchema({
    userId: String,
    topicIds: { type: Array, optional: true },
    'topicIds.$': String,
    preferredDays: { type: Array, optional: true },
    'preferredDays.$': { type: SimpleSchema.Integer, min: 0, max: 6 },
    preferredTimeWindows: { type: Array, optional: true },
    'preferredTimeWindows.$': String,
    travelRadiusMiles: { type: Number, min: 0, optional: true },
    searchCenter: { type: Object, blackbox: true, optional: true },
    pricePreference: {
      type: String,
      allowedValues: ['free', 'paid', 'flexible'],
      optional: true,
    },
    socialAtmospheres: { type: Array, optional: true },
    'socialAtmospheres.$': String,
    groupSizePreference: {
      type: String,
      allowedValues: ['small', 'medium', 'large', 'flexible'],
      optional: true,
    },
    accessibilityRequirements: { type: Array, optional: true },
    'accessibilityRequirements.$': String,
    attendanceMode: {
      type: String,
      allowedValues: ['in_person', 'online', 'hybrid', 'flexible'],
      optional: true,
    },
    preferenceStrengths: { type: Object, blackbox: true, optional: true },
    privacy: { type: Object, blackbox: true, optional: true },
    createdAt: Date,
    updatedAt: Date,
  }),
  indexes: [
    { keys: { userId: 1 }, options: { unique: true } },
  ],
});

export const RecommendationEntities = defineCollection({
  name: 'RecommendationEntities',
  schema: new SimpleSchema({
    entityType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    sourceId: String,
    name: { type: String, optional: true },
    description: { type: String, optional: true },
    visibility: { type: String, optional: true },
    metadata: { type: Object, blackbox: true, optional: true },
    createdAt: Date,
    updatedAt: Date,
  }),
  indexes: [
    { keys: { entityType: 1, sourceId: 1 }, options: { unique: true } },
    { keys: { entityType: 1, name: 1 } },
  ],
});

export const RecommendationGraphEdges = defineCollection({
  name: 'RecommendationGraphEdges',
  schema: new SimpleSchema({
    edgeKey: { type: String, optional: true },
    fromType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    fromId: String,
    toType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    toId: String,
    relation: { type: String, allowedValues: GRAPH_RELATIONS },
    // Structural source edges can predate timestamp collection. Missing means
    // unknown; it is deliberately not backfilled with a made-up epoch date.
    occurredAt: { type: Date, optional: true },
    endedAt: { type: Date, optional: true },
    weight: { type: Number, optional: true },
    sourceInteractionId: { type: String, optional: true },
    privacyEligibility: {
      type: String,
      allowedValues: ['private', 'aggregate', 'public', 'excluded'],
    },
    validFrom: { type: Date, optional: true },
    validTo: { type: Date, optional: true },
    metadata: { type: Object, blackbox: true, optional: true },
    graphVersion: { type: String, optional: true },
    createdAt: Date,
  }),
  indexes: [
    { keys: { edgeKey: 1 }, options: { unique: true, sparse: true } },
    { keys: { fromType: 1, fromId: 1, relation: 1, occurredAt: -1 } },
    { keys: { toType: 1, toId: 1, relation: 1, occurredAt: -1 } },
    { keys: { relation: 1, occurredAt: -1 } },
  ],
});

export const RecommendationFeatureSnapshots = defineCollection({
  name: 'RecommendationFeatureSnapshots',
  schema: new SimpleSchema({
    entityType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    entityId: String,
    featureVersion: String,
    asOf: Date,
    structuredFeatures: { type: Object, blackbox: true, optional: true },
    textFeatures: { type: Object, blackbox: true, optional: true },
    temporalFeatures: { type: Object, blackbox: true, optional: true },
    modelScores: { type: Object, blackbox: true, optional: true },
    availability: { type: Object, blackbox: true, optional: true },
    sourceVersions: { type: Object, blackbox: true, optional: true },
    expiresAt: { type: Date, optional: true },
  }),
  indexes: [
    { keys: { entityType: 1, entityId: 1, featureVersion: 1, asOf: -1 } },
    { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ],
});

export const RecommendationEmbeddings = defineCollection({
  name: 'RecommendationEmbeddings',
  schema: new SimpleSchema({
    entityType: { type: String, allowedValues: RECOMMENDATION_ENTITY_TYPES },
    entityId: String,
    modelVersion: String,
    embedding: { type: Array },
    'embedding.$': Number,
    dimension: { type: SimpleSchema.Integer, min: 1 },
    validFrom: Date,
    validTo: { type: Date, optional: true },
    metadata: { type: Object, blackbox: true, optional: true },
    createdAt: Date,
  }),
  indexes: [
    {
      keys: { entityType: 1, entityId: 1, modelVersion: 1, validFrom: -1 },
      options: { unique: true },
    },
    { keys: { modelVersion: 1, validTo: 1 } },
  ],
});

export const RecommendationModelVersions = defineCollection({
  name: 'RecommendationModelVersions',
  schema: new SimpleSchema({
    modelName: String,
    version: String,
    tier: { type: String, allowedValues: RECOMMENDATION_TIERS },
    status: {
      type: String,
      allowedValues: [
        'draft',
        'training',
        'shadow',
        'canary',
        'active',
        'retired',
        'rolled_back',
      ],
    },
    trainingWindowStart: { type: Date, optional: true },
    trainingWindowEnd: { type: Date, optional: true },
    datasetVersion: { type: String, optional: true },
    featureVersion: { type: String, optional: true },
    configuration: { type: Object, blackbox: true, optional: true },
    evaluation: { type: Object, blackbox: true, optional: true },
    artifactUri: { type: String, optional: true },
    createdAt: Date,
    promotedAt: { type: Date, optional: true },
    retiredAt: { type: Date, optional: true },
    rollbackVersion: { type: String, optional: true },
    notes: { type: String, optional: true },
  }),
  indexes: [
    { keys: { version: 1 }, options: { unique: true } },
    { keys: { tier: 1, status: 1, promotedAt: -1 } },
  ],
});

export const RecommendationDatasetVersions = defineCollection({
  name: 'RecommendationDatasetVersions',
  schema: new SimpleSchema({
    version: String,
    status: {
      type: String,
      allowedValues: ['building', 'ready', 'failed', 'retired'],
    },
    generatedAt: Date,
    cutoffAt: Date,
    interactionWindowStart: { type: Date, optional: true },
    interactionWindowEnd: { type: Date, optional: true },
    featureVersion: { type: String, optional: true },
    counts: { type: Object, blackbox: true, optional: true },
    checksum: { type: String, optional: true },
    uri: { type: String, optional: true },
    error: { type: String, optional: true },
  }),
  indexes: [
    { keys: { version: 1 }, options: { unique: true } },
    { keys: { generatedAt: -1, status: 1 } },
  ],
});

export const RecommendationExperiments = defineCollection({
  name: 'RecommendationExperiments',
  schema: new SimpleSchema({
    experimentKey: String,
    status: {
      type: String,
      allowedValues: ['draft', 'running', 'paused', 'complete'],
    },
    startsAt: { type: Date, optional: true },
    endsAt: { type: Date, optional: true },
    variants: { type: Object, blackbox: true },
    allocation: { type: Object, blackbox: true, optional: true },
    createdAt: Date,
    updatedAt: Date,
  }),
  indexes: [
    { keys: { experimentKey: 1 }, options: { unique: true } },
    { keys: { status: 1, startsAt: 1, endsAt: 1 } },
  ],
});

export const RecommendationAssignments = defineCollection({
  name: 'RecommendationAssignments',
  schema: new SimpleSchema({
    experimentKey: String,
    userId: String,
    variant: String,
    assignedAt: Date,
  }),
  indexes: [
    { keys: { experimentKey: 1, userId: 1 }, options: { unique: true } },
    { keys: { userId: 1, assignedAt: -1 } },
  ],
});

export const RecommendationJobs = defineCollection({
  name: 'RecommendationJobs',
  schema: new SimpleSchema({
    jobType: {
      type: String,
      allowedValues: [
        'project_graph',
        'materialize_features',
        'build_dataset',
        'train_model',
        'evaluate_model',
        'backfill',
      ],
    },
    status: {
      type: String,
      allowedValues: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
    },
    idempotencyKey: String,
    modelVersion: { type: String, optional: true },
    datasetVersion: { type: String, optional: true },
    scheduledAt: { type: Date, optional: true },
    startedAt: { type: Date, optional: true },
    heartbeatAt: { type: Date, optional: true },
    completedAt: { type: Date, optional: true },
    attempt: { type: SimpleSchema.Integer, min: 0 },
    cursor: { type: Object, blackbox: true, optional: true },
    counts: { type: Object, blackbox: true, optional: true },
    configuration: { type: Object, blackbox: true, optional: true },
    error: { type: String, optional: true },
    createdAt: Date,
    updatedAt: Date,
  }),
  indexes: [
    { keys: { idempotencyKey: 1 }, options: { unique: true } },
    { keys: { status: 1, scheduledAt: 1 } },
    { keys: { jobType: 1, createdAt: -1 } },
  ],
});

export const EventRSVPs = defineCollection({
  name: 'EventRSVPs',
  schema: new SimpleSchema({
    userId: String,
    eventId: String,
    status: { type: String, allowedValues: ['going', 'maybe', 'canceled'] },
    source: { type: String, optional: true },
    requestId: { type: String, optional: true },
    occurredAt: Date,
    createdAt: Date,
    updatedAt: Date,
  }),
  indexes: [
    { keys: { userId: 1, eventId: 1 }, options: { unique: true } },
    { keys: { eventId: 1, status: 1, updatedAt: -1 } },
  ],
});

export const EventAttendances = defineCollection({
  name: 'EventAttendances',
  schema: new SimpleSchema({
    userId: String,
    eventId: String,
    status: {
      type: String,
      allowedValues: ['self_reported', 'verified', 'removed'],
    },
    verificationSource: { type: String, optional: true },
    requestId: { type: String, optional: true },
    occurredAt: Date,
    metadata: { type: Object, blackbox: true, optional: true },
    createdAt: Date,
    updatedAt: Date,
  }),
  indexes: [
    { keys: { userId: 1, eventId: 1 }, options: { unique: true } },
    { keys: { eventId: 1, status: 1, updatedAt: -1 } },
  ],
});

export const RECOMMENDATION_COLLECTIONS = [
  RecommendationInteractions,
  UserItemStates,
  RecommendationRequests,
  RecommendationImpressions,
  RecommendationPreferences,
  RecommendationEntities,
  RecommendationGraphEdges,
  RecommendationFeatureSnapshots,
  RecommendationEmbeddings,
  RecommendationModelVersions,
  RecommendationDatasetVersions,
  RecommendationExperiments,
  RecommendationAssignments,
  RecommendationJobs,
  EventRSVPs,
  EventAttendances,
];
