import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { EventClubs } from '../../api/events/EventClubs';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import {
  EventRSVPs,
  RecommendationEntities,
  RecommendationGraphEdges,
  RecommendationInteractions,
  RecommendationJobs,
  RecommendationModelVersions,
  UserItemStates,
} from '../../api/recommendations/RecommendationData';
import { recordRecommendationInteraction } from '../../api/recommendations/interactionRecorder';
import { interactionRecordingEnabled } from '../../api/recommendations/recommendationSettings';
import { syncFriendActivityPrivacy } from '../../api/privacy/friendActivitySync';
import { TOPICS, topicForClub, topicForEvent } from '../../ui/utilities/topics';
import { VENUES } from '../../ui/utilities/venues';

/* eslint-disable no-console */

const compact = object => Object.fromEntries(
  Object.entries(object).filter(([, value]) => value !== undefined && value !== null),
);

const knownDate = value => {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const slug = value => `${value || ''}`
  .normalize('NFD')
  .replace(/[̀-ͯʻ‘’']/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 80);

const hash = value => {
  let result = 0;
  const text = `${value || ''}`;
  for (let index = 0; index < text.length; index += 1) {
    result = (result * 31 + text.charCodeAt(index)) % 1000003;
  }
  return result.toString(36);
};

const entitySourceId = (type, value) => `${type}:${slug(value) || 'unknown'}:${hash(value)}`;

const ensureEntity = ({ entityType, sourceId, name, description, metadata }) => {
  const now = new Date();
  RecommendationEntities.collection.upsert({ entityType, sourceId }, {
    $set: compact({
      name,
      description,
      metadata,
      updatedAt: now,
    }),
    $setOnInsert: { createdAt: now },
  });
  return RecommendationEntities.collection.findOne({ entityType, sourceId });
};

const ensureEdge = ({ edgeKey, fromType, fromId, toType, toId, relation, occurredAt, privacyEligibility, metadata }) => {
  const timestamp = knownDate(occurredAt);
  RecommendationGraphEdges.collection.upsert({ edgeKey }, {
    $set: compact({
      fromType,
      fromId,
      toType,
      toId,
      relation,
      occurredAt: timestamp,
      privacyEligibility,
      metadata,
      graphVersion: 'source_projection_v1',
    }),
    $setOnInsert: compact({
      validFrom: timestamp,
      createdAt: new Date(),
    }),
  });
};

const seedModelVersions = () => {
  const now = new Date();
  const models = [
    {
      modelName: 'Adaptive nullable ensemble',
      version: 'adaptive_v1',
      tier: 'hybrid',
      status: 'active',
      configuration: Meteor.settings.recommendations || {},
      notes: 'Always-on baseline with optional components and weight renormalization.',
    },
    {
      modelName: 'LightGCN collaborative challenger',
      version: 'lightgcn_v1',
      tier: 'collaborative',
      status: 'draft',
      notes: 'Activates only after an artifact and matching user/item embeddings exist.',
    },
    {
      modelName: 'Inductive heterogeneous graph challenger',
      version: 'heterogeneous_graph_v1',
      tier: 'heterogeneous',
      status: 'draft',
      notes: 'Typed graph and feature schema are ready; no model accuracy is claimed.',
    },
    {
      modelName: 'Temporal graph challenger',
      version: 'temporal_graph_v1',
      tier: 'temporal',
      status: 'draft',
      notes: 'Timestamped interactions are collected now; activation still requires a promoted model.',
    },
  ];
  models.forEach(model => {
    RecommendationModelVersions.collection.upsert({ version: model.version }, {
      $setOnInsert: { ...model, createdAt: now },
    });
  });
};

const syncTopicEntities = () => Object.entries(TOPICS).forEach(([key, topic]) => {
  ensureEntity({
    entityType: 'topic',
    sourceId: `topic:${key}`,
    name: topic.label,
    description: topic.tagline,
    metadata: { key, match: topic.match },
  });
});

const syncClubGraph = () => {
  Clubs.collection.find({}).forEach(club => {
    const topic = topicForClub(club);
    if (!topic.matched) {
      return;
    }
    const topicEntity = RecommendationEntities.collection.findOne({
      entityType: 'topic',
      sourceId: `topic:${topic.key}`,
    });
    if (topicEntity) {
      if (topic.key === 'support') {
        RecommendationGraphEdges.collection.remove({
          fromType: 'group',
          fromId: club._id,
          relation: 'has_topic',
          toId: { $ne: topicEntity._id },
        });
      }
      ensureEdge({
        edgeKey: `group:${club._id}:has_topic:${topicEntity._id}`,
        fromType: 'group',
        fromId: club._id,
        toType: 'topic',
        toId: topicEntity._id,
        relation: 'has_topic',
        occurredAt: club.createdAt,
        privacyEligibility: 'public',
      });
    }
  });
};

const eventSeriesSourceId = event => {
  const sourceId = `${event?.sourceId || ''}`;
  const match = sourceId.match(/^(.+)@\d{4}-\d{2}-\d{2}$/);
  return match?.[1] || null;
};

// The register labels this recurring series only as generic fitness/wellness,
// and the first recommendation projection consequently filed it under Move &
// Explore. The product owner confirmed the class is yoga. Keep that editorial
// correction narrow and repeatable so both existing and freshly seeded local
// records converge on the same topic without weakening ordinary topicIds.
const isLululemonYogaEvent = event => (
  `${event?.title || ''}`.trim().toLowerCase() === 'lululemon sunday sweat'
);

/**
 * Which events a boot has to project.
 *
 * Every boot used to walk every event and upsert its five or six edges whether
 * or not anything had changed. Timed on a copy of the development database —
 * 1,242 events — that was 4.3 seconds of writes that change nothing, on every
 * deploy, before the server would take a connection, and it grows with the
 * register.
 *
 * The first walk on a database is still complete. It leaves a
 * 'project_graph' row in RecommendationJobs, and later boots project only what
 * can have changed: an event still missing its topic or venue, one created or
 * edited since the last walk began (every writer of the event itself stamps
 * `updatedAt`; a minute of slack covers clocks that disagree), or one that has
 * gained a host since then. The host is its own branch because a host link is
 * a row in EventClubs, not a field on the event: 'Clubs.organizeEvent' inserts
 * one and never touches the event, so reading `updatedAt` alone left that
 * event without its `group:<club>:hosts:<event>` edge until something else
 * forced a full walk. Ranking did not show it, because it reads EventClubs
 * directly; the graph a later model trains on would have. Every writer of a
 * link stamps its `createdAt`. An edit made straight in the database without
 * touching either timestamp is therefore not picked up — touch it, or delete
 * the job row to walk everything once.
 *
 * What an event projects to also depends on two tables in the code, TOPICS and
 * VENUES, so the job row remembers a fingerprint of them and a deploy that
 * changes either walks everything once. EVENT_PROJECTION_LOGIC is for the
 * third input, this file: raise it when the projection itself changes.
 */
export const EVENT_PROJECTION_KEY = 'project-graph:events';
const EVENT_PROJECTION_LOGIC = 1;
const CLOCK_SLACK_MS = 60 * 1000;

const eventProjectionFingerprint = () => `${EVENT_PROJECTION_LOGIC}:${hash(JSON.stringify([TOPICS, VENUES]))}`;

const eventsToProject = () => {
  const lastWalk = RecommendationJobs.collection.findOne({ idempotencyKey: EVENT_PROJECTION_KEY, status: 'succeeded' });
  if (!lastWalk?.startedAt || lastWalk.configuration?.fingerprint !== eventProjectionFingerprint()) {
    return {};
  }
  const since = new Date(lastWalk.startedAt.getTime() - CLOCK_SLACK_MS);
  const newlyHosted = EventClubs.collection
    .find({ createdAt: { $gte: since } }, { fields: { eventId: 1 } })
    .map(link => link.eventId);
  return {
    $or: [
      { topicIds: { $exists: false } },
      { topicIds: { $size: 0 } },
      { venueId: { $exists: false }, location: { $nin: [null, ''] } },
      { createdAt: { $gte: since } },
      { updatedAt: { $gte: since } },
      { _id: { $in: newlyHosted } },
    ],
  };
};

const syncEventEntitiesAndGraph = () => {
  const startedAt = new Date();
  const selector = eventsToProject();
  const clubsByNumber = new Map(Clubs.collection.find({}).fetch().map(club => [club.clubID, club]));
  const linksByEvent = new Map();
  EventClubs.collection.find({}).forEach(link => {
    const links = linksByEvent.get(link.eventId) || [];
    links.push(link.clubId);
    linksByEvent.set(link.eventId, links);
  });

  let projected = 0;
  Events.collection.find(selector).forEach(event => {
    projected += 1;
    const updates = {};
    const currentTopicIds = event.topicIds || [];
    const migrateLululemonYogaProjection = isLululemonYogaEvent(event)
      && (currentTopicIds.length === 0
        || (currentTopicIds.length === 1 && currentTopicIds[0] === 'outdoors'));
    const topic = topicForEvent(migrateLululemonYogaProjection
      ? { ...event, topicIds: ['wellness'] }
      : event);
    if (topic.matched) {
      const migrateLegacySupportProjection = topic.key === 'support'
        && (currentTopicIds.length === 0
          || (currentTopicIds.length === 1 && ['wellness', 'support'].includes(currentTopicIds[0])));
      const topicEntity = RecommendationEntities.collection.findOne({
        entityType: 'topic',
        sourceId: `topic:${topic.key}`,
      });
      if ((!event.topicIds || event.topicIds.length === 0) && topicEntity) {
        updates.topicIds = [topic.key];
      }
      // The support topic was introduced after the initial recommendation
      // scaffold. Reclassify only canonical support_group records so their
      // UI topic, stored topicIds, and graph edge cannot disagree.
      if (migrateLegacySupportProjection && currentTopicIds.join(',') !== 'support') {
        updates.topicIds = ['support'];
      }
      if (migrateLululemonYogaProjection && currentTopicIds.join(',') !== 'wellness') {
        updates.topicIds = ['wellness'];
      }
      if (topicEntity) {
        if (migrateLegacySupportProjection || migrateLululemonYogaProjection) {
          RecommendationGraphEdges.collection.remove({
            fromType: 'event',
            fromId: event._id,
            relation: 'has_topic',
            toId: { $ne: topicEntity._id },
          });
        }
        ensureEdge({
          edgeKey: `event:${event._id}:has_topic:${topicEntity._id}`,
          fromType: 'event',
          fromId: event._id,
          toType: 'topic',
          toId: topicEntity._id,
          relation: 'has_topic',
          occurredAt: event.createdAt,
          privacyEligibility: 'public',
        });
      }
    }

    const location = `${event.location || ''}`.trim();
    if (location) {
      const venue = ensureEntity({
        entityType: 'venue',
        sourceId: entitySourceId('venue', location),
        name: location,
        metadata: { region: event.region },
      });
      if (!event.venueId) {
        updates.venueId = venue._id;
      }
      ensureEdge({
        edgeKey: `event:${event._id}:occurs_at:${venue._id}`,
        fromType: 'event',
        fromId: event._id,
        toType: 'venue',
        toId: venue._id,
        relation: 'occurs_at',
        occurredAt: event.createdAt,
        privacyEligibility: 'public',
      });
      const point = VENUES[location];
      if (!event.geo && point && !['zoom', 'various'].includes(location.toLowerCase())) {
        updates.geo = { type: 'Point', coordinates: [point.lng, point.lat] };
        updates.geoPrecision = 'venue';
      }
      if (!event.attendanceMode && location.toLowerCase() === 'zoom') {
        updates.attendanceMode = 'online';
      }
    }

    if (event.hostName) {
      const organizer = ensureEntity({
        entityType: 'organizer',
        sourceId: entitySourceId('organizer', event.hostName),
        name: event.hostName,
      });
      if (!event.organizerId) {
        updates.organizerId = organizer._id;
      }
      ensureEdge({
        edgeKey: `organizer:${organizer._id}:hosts:${event._id}`,
        fromType: 'organizer',
        fromId: organizer._id,
        toType: 'event',
        toId: event._id,
        relation: 'hosts',
        occurredAt: event.createdAt,
        privacyEligibility: 'public',
      });
    }

    const seriesSource = eventSeriesSourceId(event);
    if (seriesSource) {
      const series = ensureEntity({
        entityType: 'series',
        sourceId: `series:${seriesSource}`,
        name: event.title,
      });
      if (!event.seriesId) {
        updates.seriesId = series._id;
      }
      ensureEdge({
        edgeKey: `event:${event._id}:belongs_to_series:${series._id}`,
        fromType: 'event',
        fromId: event._id,
        toType: 'series',
        toId: series._id,
        relation: 'belongs_to_series',
        occurredAt: event.createdAt,
        privacyEligibility: 'public',
      });
    }

    const hostClubIds = linksByEvent.get(event._id) || [];
    const legacyHost = clubsByNumber.get(event.eventID);
    if (legacyHost && !hostClubIds.includes(legacyHost._id)) {
      hostClubIds.push(legacyHost._id);
    }
    hostClubIds.forEach(clubId => ensureEdge({
      edgeKey: `group:${clubId}:hosts:${event._id}`,
      fromType: 'group',
      fromId: clubId,
      toType: 'event',
      toId: event._id,
      relation: 'hosts',
      occurredAt: event.createdAt,
      privacyEligibility: 'public',
    }));

    if (Object.keys(updates).length > 0) {
      Events.collection.update(event._id, { $set: updates });
    }
  });

  // Written only once the walk has finished: a walk that threw leaves the old
  // row, and the next boot covers the same ground again.
  const completedAt = new Date();
  RecommendationJobs.collection.upsert({ idempotencyKey: EVENT_PROJECTION_KEY }, {
    $set: {
      jobType: 'project_graph',
      status: 'succeeded',
      attempt: 1,
      startedAt,
      completedAt,
      counts: { events: projected, complete: Object.keys(selector).length === 0 },
      configuration: { fingerprint: eventProjectionFingerprint() },
      updatedAt: completedAt,
    },
    $setOnInsert: { createdAt: completedAt },
  });
  return projected;
};

/**
 * The behaviour backfill, and the bug it used to be.
 *
 * Swipes and memberships are older than the recommendation log, so the log has
 * to be told about the ones made before it existed. The first version did that
 * by replaying EVERY swipe and EVERY membership on EVERY boot, under a
 * clientEventId of 'migration:<Collection>:<_id>'. That was idempotent against
 * itself and against nothing else. A swipe made while the server was running
 * had already been recorded by the method that made it, under the browser's
 * own clientEventId — so the first restart after it wrote the same gesture a
 * second time: a second interaction, a second graph edge, a second
 * `signalCounts` increment. Every deploy doubled every live signal recorded
 * since the one before.
 *
 * It is now three separate pieces, each run ONCE per database and recorded in
 * RecommendationJobs (a 'backfill' job under a fixed idempotency key), so later
 * boots do not walk the collections at all. Anything new after that arrives
 * through the live methods, which record it themselves.
 */
export const BACKFILL_KEYS = {
  doubleCountCleanup: 'backfill:remove-double-counted-migrations:v1',
  legacyBehavior: 'backfill:legacy-behavior:v2',
  goingRsvps: 'backfill:going-rsvps:v1',
};

/**
 * Run `work` unless this database already has. `work` returns the counts that
 * go on the job row; if it throws, no row is written and the next boot tries
 * again, which is safe because every piece below is idempotent on its own.
 */
export const runBackfillOnce = (idempotencyKey, work) => {
  if (RecommendationJobs.collection.findOne({ idempotencyKey, status: 'succeeded' })) {
    return null;
  }
  const startedAt = new Date();
  const counts = work();
  const completedAt = new Date();
  RecommendationJobs.collection.upsert({ idempotencyKey }, {
    $set: {
      jobType: 'backfill',
      status: 'succeeded',
      attempt: 1,
      startedAt,
      completedAt,
      counts,
      updatedAt: completedAt,
    },
    $setOnInsert: { createdAt: completedAt },
  });
  return counts;
};

/**
 * The live method and the old replay stamped the same gesture within
 * milliseconds of each other: one took `new Date()` for the swipe row, the
 * other a line later for the interaction, and the replay copied the row's.
 * A minute is far wider than that and far narrower than a change of mind.
 */
const TWIN_WINDOW_MS = 60 * 1000;

/**
 * Undo the double count already in the database.
 *
 * A 'migration' interaction is a duplicate when a non-migration interaction
 * says the same thing — same person, same listing, same action — at the same
 * moment. It goes, together with the two things it added: its graph edge and
 * its `signalCounts` increment.
 *
 * "At the same moment" is what keeps this from eating real history. Someone
 * who passed on an event before the log existed, and passed on it again last
 * week, made two gestures; the replayed one has no twin at ITS time and stays.
 * A replayed row with no timestamp cannot be shown to be a duplicate, so it
 * stays too. This deletes, so where it cannot be sure it does nothing.
 *
 * The interaction is removed first and everything else hangs on that removal
 * having happened here: two servers starting together must not both decrement.
 */
export const removeDoubleCountedMigrations = () => {
  let removed = 0;
  RecommendationInteractions.collection.find({ source: 'migration' }).forEach(migrated => {
    if (!migrated.occurredAt) {
      return;
    }
    const { userId, entityType, entityId, action } = migrated;
    const at = migrated.occurredAt.getTime();
    const twin = RecommendationInteractions.collection.findOne({
      userId,
      entityType,
      entityId,
      action,
      source: { $ne: 'migration' },
      occurredAt: { $gte: new Date(at - TWIN_WINDOW_MS), $lte: new Date(at + TWIN_WINDOW_MS) },
    }, { fields: { _id: 1 } });
    if (!twin || RecommendationInteractions.collection.remove({ _id: migrated._id }) !== 1) {
      return;
    }
    RecommendationGraphEdges.collection.remove({ edgeKey: `interaction:${migrated._id}` });
    UserItemStates.collection.update(
      { userId, entityType, entityId, [`signalCounts.${action}`]: { $gte: 1 } },
      { $inc: { [`signalCounts.${action}`]: -1 } },
    );
    removed += 1;
  });
  return { removed };
};

const recordedLive = ({ userId, entityType, entityId, actions }) => Boolean(
  RecommendationInteractions.collection.findOne({
    userId,
    entityType,
    entityId,
    action: { $in: actions },
    source: { $ne: 'migration' },
  }, { fields: { _id: 1 } }),
);

/**
 * What a stored swipe is to the recommender, and which recorded actions
 * already say it.
 *
 * 'going' is an RSVP. A stray 'interested' is the same gesture from before the
 * rename — the swipe migration runs first and should leave none, but a row it
 * missed must not be replayed under a retired name — and an old live
 * 'interested' interaction therefore counts as that swipe already recorded.
 * 'joined' is absent on purpose: the membership row beside it is what says
 * 'joined_group', and replaying the swipe as well was the other double count.
 */
const SWIPE_BACKFILL = {
  going: { action: 'rsvp_going', alreadySaidBy: ['rsvp_going', 'interested'] },
  interested: { action: 'rsvp_going', alreadySaidBy: ['rsvp_going', 'interested'] },
  passed: { action: 'passed', alreadySaidBy: ['passed'] },
};

const isGroupSwipe = swipe => swipe.kind === 'club';

/**
 * Record one stored row unless the log already has it, and say which happened
 * — the job row is only worth keeping if its counts are of rows written.
 * 'alreadyReplayed' is a row an earlier build's boot got to first; the
 * recorder would turn that call into a no-op anyway, but it would not say so.
 */
const backfillRow = ({ target, action, alreadySaidBy, occurredAt, clientEventId }) => {
  if (recordedLive({ ...target, actions: alreadySaidBy })) {
    return 'alreadyRecorded';
  }
  if (RecommendationInteractions.collection.findOne({ userId: target.userId, clientEventId }, { fields: { _id: 1 } })) {
    return 'alreadyReplayed';
  }
  recordRecommendationInteraction({
    ...target,
    action,
    occurredAt: occurredAt || null,
    clientEventId,
    source: 'migration',
  });
  return 'written';
};

/**
 * Tell the log about memberships and swipes it has never heard of.
 *
 * A row is skipped when the live path already recorded it. A swipe row holds
 * the person's LATEST decision and every live decision is recorded as it is
 * made, so if any live interaction says what the row says, the row is that
 * gesture. No time window is needed here, unlike the cleanup above: skipping
 * costs nothing that a wrong deletion would.
 */
export const backfillLegacyBehavior = () => {
  const counts = { memberships: 0, swipes: 0, alreadyRecorded: 0, alreadyReplayed: 0 };
  const tally = (outcome, written) => {
    counts[outcome === 'written' ? written : outcome] += 1;
  };
  ProfileClubs.collection.find({}).forEach(membership => tally(backfillRow({
    target: { userId: membership.userId, entityType: 'group', entityId: membership.clubId },
    action: 'joined_group',
    alreadySaidBy: ['joined_group'],
    occurredAt: membership.createdAt,
    clientEventId: `migration:ProfileClubs:${membership._id}`,
  }), 'memberships'));
  EventSwipes.collection.find({}).forEach(swipe => {
    const group = isGroupSwipe(swipe);
    // A right swipe on a group is a join under either of its names.
    const backfill = group && swipe.decision !== 'passed' ? null : SWIPE_BACKFILL[swipe.decision];
    if (!backfill) {
      return;
    }
    tally(backfillRow({
      target: { userId: swipe.userId, entityType: group ? 'group' : 'event', entityId: swipe.eventId },
      ...backfill,
      occurredAt: swipe.createdAt,
      clientEventId: `migration:EventSwipes:${swipe._id}`,
    }), 'swipes');
  });
  return counts;
};

/**
 * Every Going swipe gets the RSVP it always was.
 *
 * Until the rename a right swipe was logged as 'interested', which writes no
 * RSVP, so everyone who said yes before it has a Going swipe and no EventRSVPs
 * row — including the ones the backfill above skipped because their old
 * 'interested' was recorded live. They are recorded through the recorder like
 * any other RSVP, so the state row and the graph agree with the RSVP, under a
 * clientEventId of their own: 'migration:EventSwipes:<id>' may already be
 * taken by that swipe's old 'interested', and the recorder would treat a
 * second use of it as a retry and write nothing.
 */
export const backfillGoingRsvps = () => {
  let rsvps = 0;
  EventSwipes.collection.find({ decision: { $in: ['going', 'interested'] } }).forEach(swipe => {
    if (isGroupSwipe(swipe) || EventRSVPs.collection.findOne({ userId: swipe.userId, eventId: swipe.eventId })) {
      return;
    }
    recordRecommendationInteraction({
      userId: swipe.userId,
      entityType: 'event',
      entityId: swipe.eventId,
      action: 'rsvp_going',
      occurredAt: swipe.createdAt || null,
      clientEventId: `migration:going:${swipe._id}`,
      source: 'migration',
    });
    rsvps += 1;
  });
  return { rsvps };
};

/**
 * The cleanup runs first so the backfill sees the log as it should have been,
 * and the RSVPs last so they only cover what the backfill left.
 *
 * With `recordInteractions` off the recorder logs nothing, so the behaviour
 * backfill waits for a boot that can do it — marking it done now would mean it
 * never happened. The RSVP pass does not wait: RSVPs are the one thing the
 * recorder still writes with recording off.
 */
const syncLegacyBehavior = () => {
  runBackfillOnce(BACKFILL_KEYS.doubleCountCleanup, removeDoubleCountedMigrations);
  if (interactionRecordingEnabled()) {
    runBackfillOnce(BACKFILL_KEYS.legacyBehavior, backfillLegacyBehavior);
  }
  runBackfillOnce(BACKFILL_KEYS.goingRsvps, backfillGoingRsvps);
};

/** Friendships are structure, not behaviour: cheap upserts, projected every boot. */
const syncFriendGraph = () => {
  Friends.collection.find({ status: 'accepted' }).forEach(friendship => {
    [
      [friendship.requesterId, friendship.receiverId],
      [friendship.receiverId, friendship.requesterId],
    ].forEach(([fromId, toId]) => ensureEdge({
      edgeKey: `friend:${fromId}:${toId}`,
      fromType: 'user',
      fromId,
      toType: 'user',
      toId,
      relation: 'accepted_friend',
      occurredAt: friendship.respondedAt || friendship.createdAt,
      privacyEligibility: 'private',
    }));
  });
};

/**
 * Idempotent startup projection. Source records remain authoritative.
 *
 * This runs before the server accepts a connection, so how long it takes is
 * how much longer every deploy is down. It says so on every boot: a projection
 * that has quietly grown to half a minute is otherwise found out by whoever is
 * watching the launch.
 *
 * None of it depends on `recommendations.enabled`. The switch turns ranking
 * off; the topics, venues and friend-activity privacy written here are read by
 * the rest of the product and have to be right either way.
 */
export const ensureRecommendationScaffold = () => {
  if (!Meteor.isServer) {
    return;
  }
  const started = Date.now();
  seedModelVersions();
  syncTopicEntities();
  syncClubGraph();
  const projected = syncEventEntitiesAndGraph();
  syncFriendActivityPrivacy();
  syncFriendGraph();
  syncLegacyBehavior();
  console.log(`[recommendations] scaffold ready in ${Date.now() - started} ms (${projected} events projected)`);
};
