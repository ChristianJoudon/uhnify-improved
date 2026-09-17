/**
 * Null-safe adaptive recommendation ranking.
 *
 * Every scoring component is optional except baseline. A component returns
 * `available: false` when its inputs or deployed model do not exist. The final
 * score renormalizes over the components that are actually available for that
 * user and item, so sparse profiles and brand-new model tables cannot produce
 * NaN, an exception, or an empty result by themselves.
 */
import { TOPICS } from '../../ui/utilities/topics';

export const DEFAULT_COMPONENT_WEIGHTS = {
  baseline: 0.22,
  content: 0.30,
  graph: 0.18,
  collaborative: 0.12,
  heterogeneous: 0.10,
  temporal: 0.08,
};

const COMPONENT_TIER = {
  baseline: 'baseline',
  content: 'content',
  graph: 'hybrid',
  collaborative: 'collaborative',
  heterogeneous: 'heterogeneous',
  temporal: 'temporal',
};

const TIER_ORDER = [
  'baseline',
  'content',
  'hybrid',
  'collaborative',
  'heterogeneous',
  'temporal',
];

// 'interested' and 'saved' are history: a Going swipe was stored as
// 'interested' before it was called what it is, and those edges are still in
// the graph. They keep the weight they were written under. Nothing new is
// written with either name.
const POSITIVE_GRAPH_RELATIONS = new Map([
  ['joined_group', 1],
  ['followed_group', 0.75],
  ['saved', 0.9],
  ['interested', 0.7],
  ['rsvp_going', 1],
  ['attended', 1],
  ['opened', 0.25],
  ['viewed', 0.1],
]);

/**
 * How the ranker reads a person's history of one card.
 *
 * A right swipe on an event means Going, so 'rsvp_going' is the deck's
 * positive decision; an old 'interested' on an event is the same gesture under
 * the name it used to have, and is read the same way. 'passed' is the negative
 * one. A reset puts the card back to undecided: an undo, a correction, and
 * 'rsvp_canceled' — somebody who said "Not going" has not passed on the event,
 * they have taken back a plan, and the event may be offered again.
 */
const GOING_ACTIONS = ['rsvp_going', 'interested'];
const DECISION_ACTIONS = [...GOING_ACTIONS, 'passed', 'saved'];
const RESET_ACTIONS = ['rsvp_canceled', 'undo', 'correction', 'unsaved'];

/** What a person did that says "more like this". */
const POSITIVE_ACTIONS = ['rsvp_going', 'attendance_verified', 'interested', 'saved'];

/**
 * Every action the ranker reads. The method layer loads a bounded window of
 * history, and impressions outnumber decisions many times over — loading only
 * these keeps a year-old "passed" from falling out of the window behind last
 * week's scrolling, which would put the card back in the deck.
 */
export const RANKING_ACTIONS = [...new Set([...DECISION_ACTIONS, ...RESET_ACTIONS, ...POSITIVE_ACTIONS])];

const DAY_MS = 24 * 60 * 60 * 1000;

const list = value => (Array.isArray(value) ? value.filter(item => item !== null && item !== undefined) : []);

const finite = value => (Number.isFinite(Number(value)) ? Number(value) : null);

const clamp01 = value => Math.max(0, Math.min(1, finite(value) ?? 0));

const clean = value => `${value ?? ''}`.trim().toLowerCase();

const words = value => clean(value).split(/[^a-z0-9]+/).filter(Boolean);

const stableFraction = value => {
  let hash = 0;
  const text = `${value ?? ''}`;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 10007;
  }
  return hash / 10007;
};

const dateValue = value => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The most recent decision or reset for each card.
 *
 * On equal timestamps a decision outranks a reset. That tie is real: swiping
 * left over a standing RSVP records 'rsvp_canceled' and then 'passed' from one
 * method call, often inside the same millisecond, and read the other way round
 * the pass would be lost and the card dealt again.
 */
const latestDecisionByEntity = (interactions, now) => {
  const latest = new Map();
  list(interactions)
    .filter(interaction => interaction?.entityId)
    .filter(interaction => DECISION_ACTIONS.includes(interaction.action) || RESET_ACTIONS.includes(interaction.action))
    .filter(interaction => !dateValue(interaction?.occurredAt) || dateValue(interaction.occurredAt) <= now)
    .sort((left, right) => (dateValue(right?.occurredAt)?.getTime() || 0)
      - (dateValue(left?.occurredAt)?.getTime() || 0)
      || Number(RESET_ACTIONS.includes(left.action)) - Number(RESET_ACTIONS.includes(right.action)))
    .forEach(interaction => {
      if (!latest.has(interaction.entityId)) {
        latest.set(interaction.entityId, interaction.action);
      }
    });
  return latest;
};

const entityTypeFor = kind => (kind === 'group' ? 'group' : 'event');

const tokensForCandidate = candidate => new Set([
  ...list(candidate?.topicIds).map(clean),
  ...list(candidate?.categories).flatMap(words),
  ...list(candidate?.tags).flatMap(words),
  ...words(candidate?.title),
  ...words(candidate?.name),
  ...words(candidate?.description),
]);

const TOPIC_KEY_BY_NAME = new Map(Object.entries(TOPICS).flatMap(([key, topic]) => [
  [clean(key), key],
  [clean(topic.label), key],
]));

/**
 * A profile's interests, as the topic keys events are tagged with.
 *
 * Settings stores an interest as the topic's LABEL — "Move & Explore" — and an
 * event carries the topic's KEY — 'outdoors'. The ranker used to split the
 * label into words and drop them into the same bag as the keys, so that
 * profile never matched an event on its 'outdoors' tag, while "Make & Create"
 * matched every description containing the word "make" and was then explained
 * to its owner as "Matches your interests". The labels that did work ("Music &
 * Performance" against 'music') worked because a label happened to contain its
 * own key.
 *
 * Interests are a closed vocabulary, so they are resolved through it: a label
 * becomes its key, a key is already one, and anything else is dropped rather
 * than guessed at — a string the product never offered cannot honestly be
 * called the person's interest.
 */
export const topicKeysForInterests = interests => [...new Set(list(interests)
  .map(interest => TOPIC_KEY_BY_NAME.get(clean(interest)))
  .filter(Boolean))];

const tokensForUser = (profile, preferences, interactions) => {
  const explicit = [
    ...list(preferences?.topicIds),
    ...list(preferences?.socialAtmospheres),
  ].flatMap(words);
  const recent = list(interactions)
    .filter(interaction => POSITIVE_ACTIONS.includes(interaction?.action))
    .flatMap(interaction => list(interaction?.context?.topicIds).flatMap(words));
  return new Set([...topicKeysForInterests(profile?.interests), ...explicit, ...recent]);
};

const overlapRatio = (left, right) => {
  if (left.size === 0 || right.size === 0) {
    return null;
  }
  let overlap = 0;
  left.forEach(value => {
    if (right.has(value)) {
      overlap += 1;
    }
  });
  return overlap / Math.max(1, Math.min(left.size, right.size));
};

const dotSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = finite(left[index]);
    const b = finite(right[index]);
    if (a === null || b === null) {
      return null;
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }
  // Cosine is [-1, 1]; recommendation components use [0, 1].
  return clamp01((dot / Math.sqrt(leftNorm * rightNorm) + 1) / 2);
};

const available = (score, evidence) => ({
  available: score !== null && Number.isFinite(score),
  score: score === null ? null : clamp01(score),
  evidence,
});

const unavailable = reason => ({ available: false, score: null, reason });

const baselineComponent = (candidate, kind, now) => {
  const recordDate = dateValue(candidate?.date);
  const createdAt = dateValue(candidate?.createdAt);
  const expected = kind === 'group'
    ? ['name', 'description', 'location', 'meetingTime', 'categories']
    : ['title', 'description', 'date', 'location', 'categories', 'hostName'];
  const completed = expected.filter(field => {
    const value = candidate?.[field];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  }).length;
  const quality = completed / expected.length;
  const timeFit = recordDate
    ? Math.exp(-Math.max(0, recordDate.getTime() - now.getTime()) / (75 * DAY_MS))
    : 0.35;
  const freshness = createdAt
    ? Math.exp(-Math.max(0, now.getTime() - createdAt.getTime()) / (60 * DAY_MS))
    : 0.35;
  const jitter = stableFraction(candidate?._id || candidate?.sourceId || candidate?.title || candidate?.name);
  return available(0.55 * timeFit + 0.25 * quality + 0.10 * freshness + 0.10 * jitter, 'Useful upcoming option');
};

const contentComponent = (candidate, userTokens) => {
  const candidateTokens = tokensForCandidate(candidate);
  const overlap = overlapRatio(userTokens, candidateTokens);
  if (overlap === null || overlap === 0) {
    return unavailable(userTokens.size === 0 ? 'No explicit user topics' : 'No shared topic evidence');
  }
  return available(overlap, 'Matches your interests');
};

const graphComponent = ({ candidate, entityType, userId, membershipIds, graphEdges, now }) => {
  const hostIds = new Set(list(candidate?._hostClubIds).map(String));
  const joinedHost = [...hostIds].some(hostId => membershipIds.has(hostId));
  const direct = list(graphEdges)
    .filter(edge => edge?.fromType === 'user'
      && edge?.fromId === userId
      && edge?.toType === entityType
      && edge?.toId === candidate?._id
      && edge?.privacyEligibility !== 'excluded'
      // An ended edge is a plan that was cancelled or a group that was left.
      // It is history, not a reason to put the same card first.
      && (!dateValue(edge?.validTo) || dateValue(edge.validTo) > now))
    .map(edge => (finite(edge?.weight) ?? 1) * (POSITIVE_GRAPH_RELATIONS.get(edge?.relation) ?? 0))
    .filter(score => score > 0);
  if (!joinedHost && direct.length === 0) {
    return unavailable('No usable graph path');
  }
  const score = Math.max(joinedHost ? 1 : 0, ...direct.map(clamp01));
  return available(score, joinedHost ? 'From a group you joined' : 'Connected to things you enjoyed');
};

const activeModelFor = (models, tier) => list(models)
  .filter(model => model?.tier === tier && model?.status === 'active')
  .sort((left, right) => (dateValue(right?.promotedAt)?.getTime() || 0)
    - (dateValue(left?.promotedAt)?.getTime() || 0))[0] || null;

const embeddingFor = (embeddings, entityType, entityId, modelVersion, now) => list(embeddings).find(embedding => (
  embedding?.entityType === entityType
  && embedding?.entityId === entityId
  && embedding?.modelVersion === modelVersion
  && (!dateValue(embedding?.validFrom) || dateValue(embedding.validFrom) <= now)
  && (!dateValue(embedding?.validTo) || dateValue(embedding.validTo) > now)
));

const learnedEmbeddingComponent = ({
  tier,
  candidate,
  entityType,
  userId,
  models,
  embeddings,
  now,
  evidence,
}) => {
  const model = activeModelFor(models, tier);
  if (!model) {
    return unavailable(`No active ${tier} model`);
  }
  const userEmbedding = embeddingFor(embeddings, 'user', userId, model.version, now);
  const itemEmbedding = embeddingFor(embeddings, entityType, candidate?._id, model.version, now);
  const score = dotSimilarity(userEmbedding?.embedding, itemEmbedding?.embedding);
  if (score === null) {
    return unavailable(`Missing ${tier} embedding`);
  }
  return { ...available(score, evidence), modelVersion: model.version };
};

const snapshotComponent = ({ tier, candidate, entityType, models, featureSnapshots }) => {
  const model = activeModelFor(models, tier);
  if (!model) {
    return unavailable(`No active ${tier} model`);
  }
  const snapshot = list(featureSnapshots)
    .filter(item => item?.entityType === entityType && item?.entityId === candidate?._id)
    .sort((left, right) => (dateValue(right?.asOf)?.getTime() || 0)
      - (dateValue(left?.asOf)?.getTime() || 0))[0];
  const score = finite(snapshot?.modelScores?.[model.version]);
  if (score === null) {
    return unavailable(`No ${tier} score for this item`);
  }
  return {
    ...available(score, tier === 'temporal' ? 'Fits your recent rhythm' : 'Matches across related event details'),
    modelVersion: model.version,
  };
};

const contextAdjustment = (candidate, preferences, filters) => {
  let points = 0;
  let possible = 0;
  const preferredRegion = clean(filters?.region || preferences?.searchCenter?.region);
  if (preferredRegion) {
    possible += 1;
    if (clean(candidate?.region) === preferredRegion) {
      points += 1;
    }
  }
  const pricePreference = clean(filters?.pricePreference || preferences?.pricePreference);
  if (pricePreference && pricePreference !== 'flexible' && candidate?.cost?.type) {
    possible += 1;
    if (clean(candidate.cost.type) === pricePreference) {
      points += 1;
    }
  }
  const preferredDays = new Set(list(preferences?.preferredDays).map(Number));
  const recordDate = dateValue(candidate?.date);
  if (preferredDays.size > 0 && recordDate) {
    possible += 1;
    if (preferredDays.has(recordDate.getDay())) {
      points += 1;
    }
  }
  return possible === 0 ? null : points / possible;
};

const eligibility = ({ candidate, kind, now, passedIds, goingIds, membershipIds, filters }) => {
  if (!candidate?._id) {
    return false;
  }
  if (passedIds.has(candidate._id) && !filters?.includePassed) {
    return false;
  }
  // The event counterpart of "a group you have joined": already decided, so not
  // a recommendation. Only a pass used to be held back here, and an event the
  // person had said yes to was ranked and dealt again, leaving it to each page
  // to notice. A cancelled RSVP is a reset, not a decision, so it is absent
  // from `goingIds` and the event is offered again. This is the deck's rule:
  // 'recommendations.get' sets `includeGoing` for every other surface, because
  // a wall that drops a card the moment it is answered moves it from under
  // the person's thumb.
  if (kind === 'event' && goingIds.has(candidate._id) && !filters?.includeGoing) {
    return false;
  }
  if (candidate?.publicationStatus && candidate.publicationStatus !== 'published') {
    return false;
  }
  if (candidate?.cancellationStatus === 'canceled') {
    return false;
  }
  // Not public is not ranked, unless whoever gathered the candidates has
  // worked out that this person is inside it — a member of the private group,
  // or of a group hosting the private event — and marked it so (see
  // recommendationCandidates). This used to name 'private' and 'unlisted' and
  // let 'members' through to everyone; it now reads "absent or 'public'" like
  // every other test of the field, so the next value added fails closed too.
  const openToAll = candidate.visibility === undefined || candidate.visibility === 'public';
  if (!openToAll && candidate._visibleToCaller !== true) {
    return false;
  }
  if (candidate?.availabilityStatus === 'sold_out') {
    return false;
  }
  if (kind === 'event') {
    const eventDate = dateValue(candidate?.date);
    if (!eventDate || eventDate < now) {
      return false;
    }
  }
  if (kind === 'group' && membershipIds.has(candidate._id) && !filters?.includeJoined) {
    return false;
  }
  if (filters?.region && clean(candidate?.region) !== clean(filters.region)) {
    return false;
  }
  return true;
};

const selectedTier = components => components.reduce((highest, componentName) => {
  const tier = COMPONENT_TIER[componentName];
  return TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(highest) ? tier : highest;
}, 'baseline');

const reasonFor = (components, weights) => {
  const candidates = Object.entries(components)
    .filter(([name, component]) => name !== 'baseline' && component.available)
    .map(([name, component]) => ({
      evidence: component.evidence,
      contribution: (finite(weights[name]) ?? 0) * component.score,
    }))
    .sort((left, right) => right.contribution - left.contribution);
  return candidates[0]?.evidence || components.baseline.evidence;
};

const scoreOne = ({
  candidate,
  kind,
  now,
  userId,
  userTokens,
  preferences,
  filters,
  membershipIds,
  graphEdges,
  models,
  embeddings,
  featureSnapshots,
  weights,
}) => {
  const entityType = entityTypeFor(kind);
  const baseline = baselineComponent(candidate, kind, now);
  const content = contentComponent(candidate, userTokens);
  const contextual = contextAdjustment(candidate, preferences, filters);
  if (content.available && contextual !== null) {
    content.score = clamp01(0.8 * content.score + 0.2 * contextual);
  } else if (!content.available && contextual !== null) {
    content.available = true;
    content.score = clamp01(contextual);
    content.evidence = 'Fits your current filters';
  }
  const components = {
    baseline,
    content,
    graph: graphComponent({ candidate, entityType, userId, membershipIds, graphEdges, now }),
    collaborative: learnedEmbeddingComponent({
      tier: 'collaborative',
      candidate,
      entityType,
      userId,
      models,
      embeddings,
      now,
      evidence: 'People with similar activity also chose this',
    }),
    heterogeneous: learnedEmbeddingComponent({
      tier: 'heterogeneous',
      candidate,
      entityType,
      userId,
      models,
      embeddings,
      now,
      evidence: 'Matches across related event details',
    }),
    temporal: snapshotComponent({
      tier: 'temporal',
      candidate,
      entityType,
      models,
      featureSnapshots,
    }),
  };
  const used = Object.entries(components).filter(([, component]) => component.available);
  const denominator = used.reduce((sum, [name]) => sum + Math.max(0, finite(weights[name]) ?? 0), 0);
  const score = denominator > 0
    ? used.reduce((sum, [name, component]) => sum + (finite(weights[name]) ?? 0) * component.score, 0) / denominator
    : baseline.score;
  const componentNames = used.map(([name]) => name);
  return {
    ...candidate,
    recommendationScore: clamp01(score),
    selectedTier: selectedTier(componentNames),
    componentsUsed: componentNames,
    reason: reasonFor(components, weights),
    _componentScores: Object.fromEntries(Object.entries(components).map(([name, component]) => [name, {
      available: component.available,
      score: component.score,
      reason: component.reason,
      modelVersion: component.modelVersion,
    }])),
  };
};

const diversityKey = candidate => clean(list(candidate?.topicIds)[0]
  || list(candidate?.categories)[0]
  || candidate?.region
  || 'other');

const hostKey = candidate => clean(candidate?.organizerId
  || candidate?.hostName
  || list(candidate?._hostClubIds)[0]
  || 'unknown');

const displayPriorityFor = index => {
  if (index === 0) {
    return 'featured';
  }
  return index < 4 ? 'large' : 'standard';
};

const diversify = (ranked, limit) => {
  const selected = [];
  const deferred = [];
  const topicCounts = new Map();
  const hostCounts = new Map();
  ranked.forEach(candidate => {
    const topic = diversityKey(candidate);
    const host = hostKey(candidate);
    const topicLimit = selected.length < 12 ? 3 : 5;
    const hostLimit = selected.length < 10 ? 2 : 4;
    if ((topicCounts.get(topic) || 0) >= topicLimit || (hostCounts.get(host) || 0) >= hostLimit) {
      deferred.push(candidate);
      return;
    }
    selected.push(candidate);
    topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
  });
  return [...selected, ...deferred].slice(0, limit).map((candidate, index) => ({
    ...candidate,
    displayPriority: displayPriorityFor(index),
  }));
};

export const rankAdaptiveRecommendations = ({
  candidates = [],
  kind = 'event',
  userId = '',
  profile = null,
  preferences = null,
  memberships = [],
  interactions = [],
  graphEdges = [],
  models = [],
  embeddings = [],
  featureSnapshots = [],
  filters = {},
  weights = DEFAULT_COMPONENT_WEIGHTS,
  now = new Date(),
  limit = 20,
} = {}) => {
  const safeNow = dateValue(now) || new Date();
  const membershipIds = new Set(list(memberships).map(item => `${item?.clubId ?? item ?? ''}`).filter(Boolean));
  const latestDecisions = latestDecisionByEntity(interactions, safeNow);
  const passedIds = new Set([...latestDecisions.entries()]
    .filter(([, action]) => action === 'passed')
    .map(([entityId]) => entityId));
  const goingIds = new Set([...latestDecisions.entries()]
    .filter(([, action]) => GOING_ACTIONS.includes(action))
    .map(([entityId]) => entityId));
  const userTokens = tokensForUser(profile, preferences, interactions);
  const eligible = list(candidates).filter(candidate => eligibility({
    candidate,
    kind,
    now: safeNow,
    passedIds,
    goingIds,
    membershipIds,
    filters,
  }));
  const scored = eligible.map(candidate => scoreOne({
    candidate,
    kind,
    now: safeNow,
    userId,
    userTokens,
    preferences,
    filters,
    membershipIds,
    graphEdges,
    models,
    embeddings,
    featureSnapshots,
    weights: { ...DEFAULT_COMPONENT_WEIGHTS, ...(weights || {}) },
  })).sort((left, right) => right.recommendationScore - left.recommendationScore
    || stableFraction(left._id) - stableFraction(right._id));
  const items = diversify(scored, Math.max(1, Math.min(100, Number(limit) || 20)));
  const availableComponents = [...new Set(items.flatMap(item => item.componentsUsed))];
  const highestTier = items.reduce((highest, item) => (
    TIER_ORDER.indexOf(item.selectedTier) > TIER_ORDER.indexOf(highest) ? item.selectedTier : highest
  ), 'baseline');
  return {
    items,
    candidateCount: eligible.length,
    selectedTier: highestTier,
    capabilitySnapshot: {
      availableComponents,
      explicitInterestCount: topicKeysForInterests(profile?.interests).length + list(preferences?.topicIds).length,
      interactionCount: list(interactions).length,
      graphEdgeCount: list(graphEdges).length,
      activeModelTiers: list(models).filter(model => model?.status === 'active').map(model => model.tier),
      embeddingCount: list(embeddings).length,
      featureSnapshotCount: list(featureSnapshots).length,
    },
  };
};

export const stripPrivateRecommendationFields = item => {
  // Match the public listing publications: account-derived owner values stay
  // server-side, as do ranker-only working fields.
  const { _componentScores, _hostClubIds, _visibleToCaller, owner, ...safe } = item;
  return safe;
};
