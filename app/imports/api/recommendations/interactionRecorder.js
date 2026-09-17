import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import {
  EventAttendances,
  EventRSVPs,
  RecommendationGraphEdges,
  RecommendationImpressions,
  RecommendationInteractions,
  UserItemStates,
} from './RecommendationData';

const GRAPH_RELATION_FOR_ACTION = {
  opened: 'opened',
  flipped: 'opened',
  interested: 'interested',
  passed: 'passed',
  saved: 'saved',
  rsvp_going: 'rsvp_going',
  attendance_self_reported: 'attended',
  attendance_verified: 'attended',
  joined_group: 'joined_group',
  followed_group: 'followed_group',
};

const GRAPH_WEIGHT_FOR_ACTION = {
  opened: 0.25,
  flipped: 0.25,
  interested: 0.7,
  passed: -0.25,
  saved: 0.9,
  rsvp_going: 1,
  attendance_self_reported: 1,
  attendance_verified: 1,
  joined_group: 1,
  followed_group: 0.75,
};

const STATE_PATCHES = {
  interested: { interestState: 'interested' },
  passed: { interestState: 'passed' },
  saved: { saved: true },
  unsaved: { saved: false },
  rsvp_going: { rsvpStatus: 'going' },
  rsvp_maybe: { rsvpStatus: 'maybe' },
  rsvp_canceled: { rsvpStatus: 'canceled' },
  attendance_self_reported: { attendanceStatus: 'self_reported' },
  attendance_verified: { attendanceStatus: 'verified' },
  attendance_removed: { attendanceStatus: 'none' },
  joined_group: { joined: true },
  left_group: { joined: false },
  followed_group: { followed: true },
  unfollowed_group: { followed: false },
  undo: { interestState: 'neutral' },
  correction: { interestState: 'neutral' },
};

const statePatchFor = action => STATE_PATCHES[action] || {};

const compact = object => Object.fromEntries(
  Object.entries(object).filter(([, value]) => value !== undefined && value !== null),
);

const safeDate = value => {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const writeCurrentState = interaction => {
  const selector = {
    userId: interaction.userId,
    entityType: interaction.entityType,
    entityId: interaction.entityId,
  };
  const signalField = `signalCounts.${interaction.action}`;
  const statePatch = statePatchFor(interaction.action);
  const meaningful = Object.keys(statePatch).length > 0 || ['calendar_added'].includes(interaction.action);
  UserItemStates.collection.upsert(selector, {
    $set: compact({
      ...statePatch,
      lastInteractionAt: interaction.occurredAt,
      lastMeaningfulAction: meaningful ? interaction.action : undefined,
      lastRequestId: interaction.requestId,
      updatedAt: new Date(),
    }),
    $setOnInsert: compact({
      firstInteractionAt: interaction.occurredAt,
    }),
    $inc: {
      [signalField]: 1,
    },
  });
};

const writeGraphEdge = interaction => {
  const relation = GRAPH_RELATION_FOR_ACTION[interaction.action];
  if (!relation) {
    return null;
  }
  return RecommendationGraphEdges.collection.insert(compact({
    edgeKey: `interaction:${interaction._id}`,
    fromType: 'user',
    fromId: interaction.userId,
    toType: interaction.entityType,
    toId: interaction.entityId,
    relation,
    occurredAt: interaction.occurredAt,
    weight: GRAPH_WEIGHT_FOR_ACTION[interaction.action],
    sourceInteractionId: interaction._id,
    privacyEligibility: 'private',
    validFrom: interaction.occurredAt,
    createdAt: new Date(),
  }));
};

const writeImpression = interaction => {
  if (interaction.action !== 'impression' || !interaction.requestId || interaction.position === undefined) {
    return null;
  }
  const existing = interaction.clientEventId
    ? RecommendationImpressions.collection.findOne({
      userId: interaction.userId,
      clientEventId: interaction.clientEventId,
    })
    : null;
  if (existing) {
    return existing._id;
  }
  return RecommendationImpressions.collection.insert(compact({
    requestId: interaction.requestId,
    userId: interaction.userId,
    entityType: interaction.entityType,
    entityId: interaction.entityId,
    position: interaction.position,
    surface: interaction.surface || 'unknown',
    displaySize: interaction.displaySize,
    modelVersion: interaction.modelVersion || 'adaptive_v1',
    selectedTier: interaction.selectedTier || 'baseline',
    componentsUsed: interaction.componentsUsed || ['baseline'],
    shownAt: interaction.occurredAt,
    exploratory: Boolean(interaction.context?.exploratory),
    selectionPropensity: interaction.context?.selectionPropensity,
    scoreSnapshot: interaction.context?.scoreSnapshot,
    clientEventId: interaction.clientEventId,
    createdAt: new Date(),
  }));
};

const writeEventResponse = interaction => {
  if (interaction.entityType !== 'event') {
    return;
  }
  const now = new Date();
  const rsvpStatus = {
    rsvp_going: 'going',
    rsvp_maybe: 'maybe',
    rsvp_canceled: 'canceled',
  }[interaction.action];
  if (rsvpStatus) {
    EventRSVPs.collection.upsert({ userId: interaction.userId, eventId: interaction.entityId }, {
      $set: compact({
        status: rsvpStatus,
        source: interaction.source,
        requestId: interaction.requestId,
        occurredAt: interaction.occurredAt,
        updatedAt: now,
      }),
      $setOnInsert: { createdAt: now },
    });
  }
  const attendanceStatus = {
    attendance_self_reported: 'self_reported',
    attendance_verified: 'verified',
    attendance_removed: 'removed',
  }[interaction.action];
  if (attendanceStatus) {
    EventAttendances.collection.upsert({ userId: interaction.userId, eventId: interaction.entityId }, {
      $set: compact({
        status: attendanceStatus,
        verificationSource: interaction.context?.verificationSource,
        requestId: interaction.requestId,
        occurredAt: interaction.occurredAt,
        metadata: interaction.context?.attendanceMetadata,
        updatedAt: now,
      }),
      $setOnInsert: { createdAt: now },
    });
  }
};

/**
 * Server-owned append-only write used by both the new API and compatibility
 * hooks in the existing swipe, group, and friend methods.
 */
export const recordRecommendationInteraction = ({
  userId,
  entityType,
  entityId,
  action,
  occurredAt = new Date(),
  clientEventId,
  sessionId,
  requestId,
  surface,
  position,
  displaySize,
  modelVersion,
  selectedTier,
  componentsUsed,
  dwellMs,
  context,
  predecessorId,
  source = 'system',
}) => {
  if (!Meteor.isServer) {
    return null;
  }
  const normalizedOccurredAt = safeDate(occurredAt);
  const eventId = clientEventId || `${source}:${Random.id()}`;
  const existing = RecommendationInteractions.collection.findOne({ userId, clientEventId: eventId });
  if (existing) {
    return existing._id;
  }
  const document = compact({
    userId,
    entityType,
    entityId,
    action,
    occurredAt: normalizedOccurredAt,
    clientEventId: eventId,
    sessionId,
    requestId,
    surface,
    position,
    displaySize,
    modelVersion,
    selectedTier,
    componentsUsed,
    dwellMs,
    context,
    predecessorId,
    source,
    createdAt: new Date(),
  });
  let interactionId;
  try {
    interactionId = RecommendationInteractions.collection.insert(document);
  } catch (error) {
    // A retry can race the first request between the read above and the unique
    // index. In that case idempotency means returning the winning row.
    if (error?.code === 11000) {
      return RecommendationInteractions.collection.findOne({ userId, clientEventId: eventId })?._id;
    }
    throw error;
  }
  const interaction = { ...document, _id: interactionId };
  writeCurrentState(interaction);
  writeGraphEdge(interaction);
  writeImpression(interaction);
  writeEventResponse(interaction);
  return interactionId;
};
