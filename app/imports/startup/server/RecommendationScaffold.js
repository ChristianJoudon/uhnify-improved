import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { EventClubs } from '../../api/events/EventClubs';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import {
  RecommendationEntities,
  RecommendationGraphEdges,
  RecommendationModelVersions,
} from '../../api/recommendations/RecommendationData';
import { recordRecommendationInteraction } from '../../api/recommendations/interactionRecorder';
import { friendActivityVisibilityFor } from '../../api/privacy/FriendActivityPrivacy';
import { TOPICS, topicForClub, topicForEvent } from '../../ui/utilities/topics';
import { VENUES } from '../../ui/utilities/venues';

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

const syncEventEntitiesAndGraph = () => {
  const clubsByNumber = new Map(Clubs.collection.find({}).fetch().map(club => [club.clubID, club]));
  const linksByEvent = new Map();
  EventClubs.collection.find({}).forEach(link => {
    const links = linksByEvent.get(link.eventId) || [];
    links.push(link.clubId);
    linksByEvent.set(link.eventId, links);
  });

  Events.collection.find({}).forEach(event => {
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
};

const syncLegacyBehavior = () => {
  ProfileClubs.collection.find({}).forEach(membership => {
    recordRecommendationInteraction({
      userId: membership.userId,
      entityType: 'group',
      entityId: membership.clubId,
      action: 'joined_group',
      occurredAt: membership.createdAt || null,
      clientEventId: `migration:ProfileClubs:${membership._id}`,
      source: 'migration',
    });
  });
  EventSwipes.collection.find({}).forEach(swipe => {
    recordRecommendationInteraction({
      userId: swipe.userId,
      entityType: swipe.kind === 'club' ? 'group' : 'event',
      entityId: swipe.eventId,
      action: swipe.decision,
      occurredAt: swipe.createdAt || null,
      clientEventId: `migration:EventSwipes:${swipe._id}`,
      source: 'migration',
    });
  });
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

const syncFriendActivityPrivacy = () => {
  const clubs = new Map(Clubs.collection.find({}).fetch().map(club => [club._id, club]));
  const events = new Map(Events.collection.find({}).fetch().map(event => [event._id, event]));

  ProfileClubs.collection.find({}).forEach(membership => {
    const friendActivityVisibility = friendActivityVisibilityFor(clubs.get(membership.clubId));
    if (membership.friendActivityVisibility !== friendActivityVisibility) {
      ProfileClubs.collection.update(membership._id, { $set: { friendActivityVisibility } });
    }
  });

  EventSwipes.collection.find({}).forEach(swipe => {
    const listing = swipe.kind === 'club'
      ? clubs.get(swipe.eventId)
      : events.get(swipe.eventId);
    const friendActivityVisibility = friendActivityVisibilityFor(listing);
    if (swipe.friendActivityVisibility !== friendActivityVisibility) {
      EventSwipes.collection.update(swipe._id, { $set: { friendActivityVisibility } });
    }
  });
};

/** Idempotent startup projection. Source records remain authoritative. */
export const ensureRecommendationScaffold = () => {
  if (!Meteor.isServer) {
    return;
  }
  seedModelVersions();
  syncTopicEntities();
  syncClubGraph();
  syncEventEntitiesAndGraph();
  syncFriendActivityPrivacy();
  syncLegacyBehavior();
};
