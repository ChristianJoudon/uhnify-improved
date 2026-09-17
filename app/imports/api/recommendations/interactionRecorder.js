import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import {
  EventAttendances,
  EventRSVPs,
  RETIRED_ACTIONS,
  RecommendationGraphEdges,
  RecommendationImpressions,
  RecommendationInteractions,
  UserItemStates,
} from './RecommendationData';
import { interactionRecordingEnabled } from './recommendationSettings';

const GRAPH_RELATION_FOR_ACTION = {
  opened: 'opened',
  flipped: 'opened',
  passed: 'passed',
  rsvp_going: 'rsvp_going',
  attendance_self_reported: 'attended',
  attendance_verified: 'attended',
  joined_group: 'joined_group',
  followed_group: 'followed_group',
};

const GRAPH_WEIGHT_FOR_ACTION = {
  opened: 0.25,
  flipped: 0.25,
  passed: -0.25,
  rsvp_going: 1,
  attendance_self_reported: 1,
  attendance_verified: 1,
  joined_group: 1,
  followed_group: 0.75,
};

/**
 * The relations an action brings to an end.
 *
 * An edge used to be written and never closed, so the graph went on saying
 * "is going to" about a plan the person had cancelled and "joined" about a
 * group they had left. The ranker scores a direct edge to a candidate as the
 * strongest evidence it has, which put the event somebody had just said "Not
 * going" to — and the group they had just left — at the very top of their
 * deck. 'interested' is here because that is the relation a Going swipe was
 * stored under before the rename, and cancelling it has to reach those too.
 */
const RELATIONS_ENDED_BY_ACTION = {
  rsvp_canceled: ['rsvp_going', 'interested'],
  left_group: ['joined_group'],
  unfollowed_group: ['followed_group'],
};

/**
 * Going is the deck's positive decision, and it lives in `rsvpStatus`, not in
 * `interestState` — a second field saying 'interested' would be the old name
 * for the same gesture coming back. What both RSVP actions do to
 * `interestState` is clear it. A person can pass on an event and later say
 * they are going; without the reset the state row says passed AND going, and
 * whatever reads it next has to guess which one is current. Cancelling resets
 * it for the same reason an undo does: the card is undecided again and may be
 * offered again.
 */
const STATE_PATCHES = {
  passed: { interestState: 'passed' },
  rsvp_going: { rsvpStatus: 'going', interestState: 'neutral' },
  rsvp_maybe: { rsvpStatus: 'maybe' },
  rsvp_canceled: { rsvpStatus: 'canceled', interestState: 'neutral' },
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

const endGraphEdges = interaction => {
  const relations = RELATIONS_ENDED_BY_ACTION[interaction.action];
  if (!relations) {
    return;
  }
  const endedAt = interaction.occurredAt || new Date();
  RecommendationGraphEdges.collection.update({
    fromType: 'user',
    fromId: interaction.userId,
    toType: interaction.entityType,
    toId: interaction.entityId,
    relation: { $in: relations },
    validTo: { $exists: false },
  }, { $set: { validTo: endedAt, endedAt } }, { multi: true });
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

/**
 * The one write here that is not behaviour logging.
 *
 * Whether somebody is going to an event, and whether they went, is a fact
 * about their plans that the product shows back to them. It is kept even when
 * `recordInteractions` is off: that switch stops MatchBook taking notes about
 * people, and must not make it forget what they told it.
 */
const writeEventResponse = interaction => {
  if (interaction.entityType !== 'event') {
    return;
  }
  // Both collections require `occurredAt`, and a backfilled swipe can predate
  // the field it would be read from. The log leaves an unknown time unknown;
  // these rows cannot, so they take the time MatchBook learned of the plan.
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
        occurredAt: interaction.occurredAt || now,
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
        occurredAt: interaction.occurredAt || now,
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
 *
 * Returns the interaction's id, or null when nothing was logged — on the
 * client, and whenever `recommendations.recordInteractions` is false. What is
 * not logged then is not logged later either: nothing replays the gap. A retired
 * action is refused outright, so a caller still using the old name for a
 * gesture hears about it instead of quietly splitting one signal in two.
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
  if (RETIRED_ACTIONS.includes(action)) {
    throw new Meteor.Error('retired-action', `"${action}" is kept as history and is no longer recorded.`);
  }
  const normalizedOccurredAt = safeDate(occurredAt);
  if (!interactionRecordingEnabled()) {
    // Two things still happen with recording off. The RSVP or attendance is
    // kept, because it is what the person told the product. And an edge this
    // action brings to an end is ended: that adds nothing about the person, it
    // stops a note already taken from going on being wrong. Without it a plan
    // cancelled, or a group left, while recording was paused kept its weight-1
    // edge for good, and once recording was back the ranker went on putting
    // that card first.
    const unlogged = compact({
      userId,
      entityType,
      entityId,
      action,
      occurredAt: normalizedOccurredAt,
      requestId,
      context,
      source,
    });
    endGraphEdges(unlogged);
    writeEventResponse(unlogged);
    return null;
  }
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
  endGraphEdges(interaction);
  writeGraphEdge(interaction);
  writeImpression(interaction);
  writeEventResponse(interaction);
  return interactionId;
};
