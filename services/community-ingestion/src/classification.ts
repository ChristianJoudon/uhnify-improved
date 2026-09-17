import type { SourceDefinition } from './contracts.js';
import { stableHash } from './hash.js';

export const CLASSIFICATION_TAXONOMY_VERSION = 'matchbook-topics.v1' as const;

/**
 * Keys and labels intentionally mirror app/imports/api/ingestion/
 * IngestionReviewTaxonomy.js. The service owns no second public taxonomy; this
 * closed copy only makes worker output deterministic and type-safe.
 */
export const MATCHBOOK_CLASSIFICATION_TAXONOMY = {
  outdoors: {
    label: 'Move & Explore',
    subcategories: {
      outdoor_recreation: 'Outdoor recreation',
      fitness_movement: 'Fitness & movement',
      water_sports: 'Water sports',
      nature_environment: 'Nature & environment',
      spectator_sports: 'Sports & games',
    },
  },
  music: {
    label: 'Music & Performance',
    subcategories: {
      live_music: 'Live music',
      dance_hula: 'Dance & hula',
      theater_comedy: 'Theater & comedy',
      open_mic_karaoke: 'Open mic & karaoke',
      parade_performance: 'Parades & performances',
    },
  },
  books: {
    label: 'Books & Ideas',
    subcategories: {
      classes_workshops: 'Classes & workshops',
      talks_discussions: 'Talks & discussions',
      books_writing: 'Books & writing',
      storytime_literacy: 'Storytime & literacy',
      history_culture: 'History & culture',
    },
  },
  food: {
    label: 'Food & Markets',
    subcategories: {
      farmers_market: 'Farmers markets',
      local_market: 'Makers & local markets',
      community_meals: 'Community meals',
      food_drink: 'Food & drink',
      cooking: 'Cooking',
    },
  },
  art: {
    label: 'Make & Create',
    subcategories: {
      arts_crafts: 'Arts & crafts',
      visual_art_exhibitions: 'Visual art & exhibitions',
      film_photography: 'Film & photography',
      maker_technology: 'Making & technology',
    },
  },
  community: {
    label: 'Community & Causes',
    subcategories: {
      civic_government: 'Civic & government',
      volunteer_service: 'Volunteer & service',
      business_networking: 'Business & networking',
      faith_spirituality: 'Faith & spirituality',
      family_youth: 'Family & youth',
      senior_services: 'Senior services',
      cultural_community: 'Culture & community',
    },
  },
  support: {
    label: 'Support Groups',
    subcategories: {
      addiction_recovery: 'Addiction recovery',
      family_addiction_support: 'Family addiction support',
      mental_health_peer: 'Mental health peer support',
      mental_health_family: 'Mental health family support',
      dementia_caregiver: 'Dementia caregiver support',
      caregiver_support: 'Caregiver support',
      general_support: 'General support',
    },
  },
  wellness: {
    label: 'Family & Wellbeing',
    subcategories: {
      yoga_meditation: 'Yoga & meditation',
      health_wellness: 'Health & wellness',
      keiki_family: 'Keiki & family',
      kupuna_aging: 'Kūpuna & aging',
      gardening_home: 'Gardening & home',
      parenting_playgroups: 'Parenting & playgroups',
    },
  },
  night: {
    label: 'Nights Out',
    subcategories: {
      festivals_fairs: 'Festivals & fairs',
      nightlife_social: 'Nightlife & social',
      games_trivia: 'Games & trivia',
      holiday_celebration: 'Holiday celebrations',
    },
  },
} as const;

export type MatchBookTopicKey = keyof typeof MATCHBOOK_CLASSIFICATION_TAXONOMY;

type SubcategoryFor<Topic extends MatchBookTopicKey> = Extract<
  keyof (typeof MATCHBOOK_CLASSIFICATION_TAXONOMY)[Topic]['subcategories'],
  string
>;

export type MatchBookSubcategoryKey = {
  [Topic in MatchBookTopicKey]: SubcategoryFor<Topic>;
}[MatchBookTopicKey];

export type ClassificationReason =
  | 'EXPLICIT_SUPPORT_TYPE'
  | 'SOURCE_CATEGORY_MATCH'
  | 'TITLE_MATCH'
  | 'DESCRIPTION_MATCH'
  | 'CONTEXT_MATCH'
  | 'SOURCE_PROFILE_MATCH'
  | 'FALLBACK_COMMUNITY';

export type ClassificationSuggestion = {
  [Topic in MatchBookTopicKey]: {
    taxonomyVersion: typeof CLASSIFICATION_TAXONOMY_VERSION;
    topicKey: Topic;
    subcategoryKey: SubcategoryFor<Topic>;
    confidence: number;
    reasons: ClassificationReason[];
  };
}[MatchBookTopicKey];

export type ClassificationInput = {
  entityHint: 'event' | 'group';
  normalizedFields: Record<string, unknown>;
  source: Pick<SourceDefinition, 'id' | 'slug' | 'displayName' | 'publisherName' | 'contentKinds'>;
};

type Rule = {
  topicKey: MatchBookTopicKey;
  subcategoryKey: MatchBookSubcategoryKey;
  phrases: readonly string[];
};

const RULES: readonly Rule[] = [
  {
    topicKey: 'outdoors',
    subcategoryKey: 'outdoor_recreation',
    phrases: ['outdoor recreation', 'outdoors', 'outdoor', 'hiking', 'hike', 'trail', 'camping', 'walking tour'],
  },
  {
    topicKey: 'outdoors',
    subcategoryKey: 'fitness_movement',
    phrases: ['fitness', 'workout', 'running', 'run club', 'walking club', 'movement class', 'fusion flow', 'barre', 'pilates', 'zumba', 'tai chi'],
  },
  {
    topicKey: 'outdoors',
    subcategoryKey: 'water_sports',
    phrases: ['water sports', 'watersports', 'stand up paddle', 'paddle', 'surfing', 'surf', 'canoe', 'kayak', 'ocean swim', 'beach'],
  },
  {
    topicKey: 'outdoors',
    subcategoryKey: 'nature_environment',
    phrases: ['nature', 'environment', 'environmental', 'sustainability', 'conservation', 'ecology', 'wildlife'],
  },
  {
    topicKey: 'outdoors',
    subcategoryKey: 'spectator_sports',
    phrases: ['spectator sports', 'sports', 'sport', 'golf', 'soccer', 'football', 'basketball', 'volleyball', 'pickleball', 'tournament'],
  },
  {
    topicKey: 'music',
    subcategoryKey: 'live_music',
    phrases: ['live music', 'jam sessions', 'jam session', 'music', 'concert', 'band', 'choir', 'ukulele', 'kanikapila'],
  },
  {
    topicKey: 'music',
    subcategoryKey: 'dance_hula',
    phrases: ['dance', 'dancing', 'hula'],
  },
  {
    topicKey: 'music',
    subcategoryKey: 'theater_comedy',
    phrases: ['theater', 'theatre', 'comedy', 'stage play', 'magic show', 'magic'],
  },
  {
    topicKey: 'music',
    subcategoryKey: 'open_mic_karaoke',
    phrases: ['open mic', 'karaoke'],
  },
  {
    topicKey: 'music',
    subcategoryKey: 'parade_performance',
    phrases: ['parade', 'performance', 'fire show', 'showcase', 'luau'],
  },
  {
    topicKey: 'books',
    subcategoryKey: 'classes_workshops',
    phrases: ['class', 'classes', 'learning', 'education', 'school', 'college', 'student', 'math', 'library program', 'library'],
  },
  {
    topicKey: 'books',
    subcategoryKey: 'talks_discussions',
    phrases: ['talk', 'lecture', 'discussion', 'speaker', 'public speaking', 'panel'],
  },
  {
    topicKey: 'books',
    subcategoryKey: 'books_writing',
    phrases: ['book', 'books', 'reading', 'writing', 'writer', 'writers', 'poetry', 'author'],
  },
  {
    topicKey: 'books',
    subcategoryKey: 'storytime_literacy',
    phrases: ['storytime', 'story time', 'literacy'],
  },
  {
    topicKey: 'books',
    subcategoryKey: 'history_culture',
    phrases: ['history', 'historical', 'cultural history'],
  },
  {
    topicKey: 'food',
    subcategoryKey: 'farmers_market',
    phrases: ['farmers market', 'farmer market', 'farm stand', 'produce market'],
  },
  {
    topicKey: 'food',
    subcategoryKey: 'local_market',
    phrases: ['local market', 'night market', 'craft market', 'craft fair', 'makers market', 'makers fair', 'artisan fair', 'aloha market', 'market'],
  },
  {
    topicKey: 'food',
    subcategoryKey: 'community_meals',
    phrases: ['community meals', 'community meal', 'congregate meals', 'congregate meal', 'meal program', 'lunch program'],
  },
  {
    topicKey: 'food',
    subcategoryKey: 'food_drink',
    phrases: ['food and drink', 'food drink', 'food', 'dinner', 'potluck', 'coffee', 'beer', 'tasting'],
  },
  {
    topicKey: 'food',
    subcategoryKey: 'cooking',
    phrases: ['cooking class', 'cooking', 'culinary'],
  },
  {
    topicKey: 'art',
    subcategoryKey: 'arts_crafts',
    phrases: ['arts and crafts', 'arts crafts', 'lei workshop', 'craft workshop', 'art class', 'quilt exhibit', 'workshop', 'craft', 'crafts', 'lei making', 'printmaking', 'quilting', 'quilter', 'quilters', 'quilt'],
  },
  {
    topicKey: 'art',
    subcategoryKey: 'visual_art_exhibitions',
    phrases: ['visual art', 'art exhibition', 'art', 'exhibition', 'gallery', 'painting', 'sculpture', 'fashion', 'design', 'culture'],
  },
  {
    topicKey: 'art',
    subcategoryKey: 'film_photography',
    phrases: ['film', 'movie', 'cinema', 'photography', 'photo walk'],
  },
  {
    topicKey: 'art',
    subcategoryKey: 'maker_technology',
    phrases: ['maker technology', 'technology', 'robotics', 'lego', 'coding', 'makerspace'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'civic_government',
    phrases: ['civic', 'government', 'county council', 'public hearing', 'town hall', 'advocacy'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'volunteer_service',
    phrases: ['community cleanup', 'beach cleanup', 'cleanup', 'clean up', 'volunteer', 'service project', 'donation drive', 'fundraiser'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'business_networking',
    phrases: ['business networking', 'networking', 'business', 'professional', 'leadership', 'conference'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'faith_spirituality',
    phrases: ['faith', 'spirituality', 'spiritual', 'church', 'temple'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'family_youth',
    phrases: ['family and youth', 'family youth', 'youth leadership', 'youth service', 'youth advocacy', 'family resource'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'senior_services',
    phrases: ['senior services', 'senior assistance', 'senior center'],
  },
  {
    topicKey: 'community',
    subcategoryKey: 'cultural_community',
    phrases: ['cultural community', 'community', 'heritage', 'veterans', 'lgbtq', 'women'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'addiction_recovery',
    phrases: ['addiction recovery', 'alcoholics anonymous', 'narcotics anonymous', 'recovery meeting', 'aa meeting', 'na meeting', 'sobriety'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'family_addiction_support',
    phrases: ['family addiction support', 'al anon', 'family recovery'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'mental_health_peer',
    phrases: ['mental health peer', 'peer support', 'nami connection'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'mental_health_family',
    phrases: ['mental health family', 'nami family'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'dementia_caregiver',
    phrases: ['dementia caregiver', 'alzheimer caregiver', 'memory caregiver'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'caregiver_support',
    phrases: ['caregiver support', 'caregiving support', 'caregiver group'],
  },
  {
    topicKey: 'support',
    subcategoryKey: 'general_support',
    phrases: ['support group', 'support meeting', 'peer group'],
  },
  {
    topicKey: 'wellness',
    subcategoryKey: 'yoga_meditation',
    phrases: ['yoga class', 'yoga stretch', 'yoga', 'stretching', 'stretch', 'meditation', 'sound bath', 'mindfulness'],
  },
  {
    topicKey: 'wellness',
    subcategoryKey: 'health_wellness',
    phrases: ['health and wellness', 'health wellness', 'community health', 'healthcare', 'wellness', 'health', 'mental health', 'safety'],
  },
  {
    topicKey: 'wellness',
    subcategoryKey: 'keiki_family',
    phrases: ['keiki and family', 'keiki family', 'youth summer camp', 'summer camp', 'keiki', 'family activity', 'family fun', 'children', 'kids', 'youth'],
  },
  {
    topicKey: 'wellness',
    subcategoryKey: 'kupuna_aging',
    phrases: ['kupuna and aging', 'kupuna aging', 'kupuna', 'healthy aging', 'aging services', 'elder care', 'elderly', 'seniors'],
  },
  {
    topicKey: 'wellness',
    subcategoryKey: 'gardening_home',
    phrases: ['gardening and home', 'gardening home', 'food forest', 'gardening', 'garden', 'plants', 'plant', 'home'],
  },
  {
    topicKey: 'wellness',
    subcategoryKey: 'parenting_playgroups',
    phrases: ['parenting', 'playgroup', 'play group', 'early childhood', 'family activity'],
  },
  {
    topicKey: 'night',
    subcategoryKey: 'festivals_fairs',
    phrases: ['festival', 'festivals', 'fair', 'fairs'],
  },
  {
    topicKey: 'night',
    subcategoryKey: 'nightlife_social',
    phrases: ['nightlife', 'night out', 'club night', 'happy hour', 'night market', 'social', 'party', 'mixer'],
  },
  {
    topicKey: 'night',
    subcategoryKey: 'games_trivia',
    phrases: ['games and trivia', 'games trivia', 'games', 'game night', 'trivia', 'bingo'],
  },
  {
    topicKey: 'night',
    subcategoryKey: 'holiday_celebration',
    phrases: ['holiday celebration', 'holiday', 'celebration'],
  },
] as const;

const REASON_ORDER: readonly ClassificationReason[] = [
  'EXPLICIT_SUPPORT_TYPE',
  'TITLE_MATCH',
  'SOURCE_CATEGORY_MATCH',
  'DESCRIPTION_MATCH',
  'CONTEXT_MATCH',
  'SOURCE_PROFILE_MATCH',
  'FALLBACK_COMMUNITY',
];

const normalizeText = (value: string): string => value
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/['’ʻʼ]/g, '')
  .replace(/[_&]+/g, match => match === '&' ? ' and ' : ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const stringsFrom = (value: unknown): string[] => {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  return [];
};

const textFrom = (values: unknown[]): string => normalizeText(values.flatMap(stringsFrom).join(' '));

const phraseSpecificity = (text: string, phrases: readonly string[]): number => {
  if (!text) return 0;
  const paddedText = ` ${text} `;
  return phrases.reduce((best, phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    if (!normalizedPhrase || !paddedText.includes(` ${normalizedPhrase} `)) return best;
    return Math.max(best, normalizedPhrase.split(' ').length);
  }, 0);
};

type ScoredRule = Rule & {
  categorySpecificity: number;
  titleSpecificity: number;
  descriptionSpecificity: number;
  contextSpecificity: number;
  sourceSpecificity: number;
  reasons: Set<ClassificationReason>;
};

const confidenceFor = (winner: ScoredRule): number => {
  const primary = winner.titleSpecificity
    ? { channel: 'title', base: winner.titleSpecificity > 1 ? 0.86 : 0.78 }
    : winner.categorySpecificity
      ? { channel: 'category', base: winner.categorySpecificity > 1 ? 0.88 : 0.76 }
      : winner.descriptionSpecificity
        ? { channel: 'description', base: winner.descriptionSpecificity > 1 ? 0.68 : 0.60 }
        : winner.contextSpecificity
          ? { channel: 'context', base: winner.contextSpecificity > 1 ? 0.62 : 0.54 }
          : { channel: 'source', base: winner.sourceSpecificity > 1 ? 0.52 : 0.44 };
  const corroboratingSignals = [
    ['category', winner.categorySpecificity],
    ['description', winner.descriptionSpecificity],
    ['context', winner.contextSpecificity],
    ['source', winner.sourceSpecificity],
  ].filter(([channel, specificity]) => channel !== primary.channel && Number(specificity) > 0).length;
  return Math.min(0.97, Number((primary.base + Math.min(0.09, corroboratingSignals * 0.03)).toFixed(2)));
};

const sourcePathText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).pathname.replace(/[-_/]+/g, ' ');
  } catch {
    return undefined;
  }
};

const asSuggestion = (
  topicKey: MatchBookTopicKey,
  subcategoryKey: MatchBookSubcategoryKey,
  confidence: number,
  reasons: ClassificationReason[],
): ClassificationSuggestion => ({
  taxonomyVersion: CLASSIFICATION_TAXONOMY_VERSION,
  topicKey,
  subcategoryKey,
  confidence,
  reasons,
} as ClassificationSuggestion);

export const suggestClassification = (input: ClassificationInput): ClassificationSuggestion => {
  const fields = input.normalizedFields;
  const supportSubtype = typeof fields.supportSubtype === 'string' ? fields.supportSubtype : undefined;
  const supportSubcategories = MATCHBOOK_CLASSIFICATION_TAXONOMY.support.subcategories;
  const explicitSupportSubtype = supportSubtype && supportSubtype in supportSubcategories
    ? supportSubtype as keyof typeof supportSubcategories
    : undefined;
  const sourceCategoryText = textFrom([
    fields.category,
    fields.categories,
    fields.tags,
    fields.topic,
    fields.topics,
    fields.listingType,
  ]);
  const explicitSupportType = normalizeText(`${fields.listingType ?? ''}`) === 'support group'
    || phraseSpecificity(sourceCategoryText, ['support group']) > 0;
  if (explicitSupportSubtype || explicitSupportType) {
    return asSuggestion(
      'support',
      explicitSupportSubtype ?? 'general_support',
      explicitSupportSubtype ? 0.99 : 0.96,
      explicitSupportSubtype
        ? ['EXPLICIT_SUPPORT_TYPE', 'SOURCE_CATEGORY_MATCH']
        : ['EXPLICIT_SUPPORT_TYPE'],
    );
  }

  const titleText = textFrom([fields.title, fields.name]);
  const descriptionText = textFrom([fields.description, fields.summary, fields.excerpt]);
  const contextSignalText = textFrom([
    fields.context,
    fields.contextLabels,
    fields.locationHint,
    fields.location,
    fields.venue,
    fields.venueName,
  ]);
  const sourceProfileText = textFrom([
    input.source.slug,
    input.source.displayName,
    input.source.publisherName,
    input.source.contentKinds,
    sourcePathText(fields.sourceUrl),
  ]);

  const scored = RULES.map<ScoredRule>(rule => {
    const categorySpecificity = phraseSpecificity(sourceCategoryText, rule.phrases);
    const titleSpecificity = phraseSpecificity(titleText, rule.phrases);
    const descriptionSpecificity = phraseSpecificity(descriptionText, rule.phrases);
    const contextSpecificity = phraseSpecificity(contextSignalText, rule.phrases);
    const sourceSpecificity = phraseSpecificity(sourceProfileText, rule.phrases);
    const reasons = new Set<ClassificationReason>();
    if (categorySpecificity) reasons.add('SOURCE_CATEGORY_MATCH');
    if (titleSpecificity) reasons.add('TITLE_MATCH');
    if (descriptionSpecificity) reasons.add('DESCRIPTION_MATCH');
    if (contextSpecificity) reasons.add('CONTEXT_MATCH');
    if (sourceSpecificity) reasons.add('SOURCE_PROFILE_MATCH');
    return {
      ...rule,
      categorySpecificity,
      titleSpecificity,
      descriptionSpecificity,
      contextSpecificity,
      sourceSpecificity,
      reasons,
    };
  });
  const winnerFor = (
    specificity: keyof Pick<
      ScoredRule,
      'titleSpecificity' | 'categorySpecificity' | 'descriptionSpecificity' | 'contextSpecificity' | 'sourceSpecificity'
    >,
  ): ScoredRule | undefined => scored.reduce<ScoredRule | undefined>((best, candidate) => {
    if (!candidate[specificity]) return best;
    if (!best || candidate[specificity] > best[specificity]) return candidate;
    if (candidate[specificity] < best[specificity]) return best;
    const supportingScore = (rule: ScoredRule): number => (
      rule.categorySpecificity * 8
      + rule.descriptionSpecificity * 4
      + rule.contextSpecificity * 2
      + rule.sourceSpecificity
    );
    return supportingScore(candidate) > supportingScore(best) ? candidate : best;
  }, undefined);
  // MatchBook names an event for what it is: a title signal wins outright.
  // Publisher categories, description, item-local context, and source profile
  // are progressively weaker fallbacks. They can corroborate a title tie, but
  // no weaker channel can replace a title interpretation outright.
  const winner = winnerFor('titleSpecificity')
    ?? winnerFor('categorySpecificity')
    ?? winnerFor('descriptionSpecificity')
    ?? winnerFor('contextSpecificity')
    ?? winnerFor('sourceSpecificity');

  if (!winner) {
    return asSuggestion('community', 'cultural_community', 0.25, ['FALLBACK_COMMUNITY']);
  }
  return asSuggestion(
    winner.topicKey,
    winner.subcategoryKey,
    confidenceFor(winner),
    REASON_ORDER.filter(reason => winner.reasons.has(reason)),
  );
};

const normalizedIdentityValues = (value: unknown): string[] => [...new Set(
  stringsFrom(value).map(normalizeText).filter(Boolean),
)].sort();

const localDateTimeFrom = (
  value: unknown,
  timeZoneValue: unknown,
): { localDate: string; localTime: string } | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  const timeZone = typeof timeZoneValue === 'string' && timeZoneValue.trim()
    ? timeZoneValue.trim()
    : undefined;
  if (!Number.isNaN(parsed.getTime()) && timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(parsed);
      const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => (
        parts.find(candidate => candidate.type === type)?.value
      );
      const year = part('year');
      const month = part('month');
      const day = part('day');
      const hour = part('hour');
      const minute = part('minute');
      if (year && month && day && hour && minute) {
        return { localDate: `${year}-${month}-${day}`, localTime: `${hour}:${minute}` };
      }
    } catch {
      // Fall back to the supplied wall-clock representation when a source has
      // not yet provided a valid IANA timezone.
    }
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/);
  return match?.[1] && match[2]
    ? { localDate: match[1], localTime: match[2] }
    : undefined;
};

type SeriesIdentity = {
  sourceId: string;
  entityHint: 'event' | 'group';
  names: string[];
  locations: string[];
  localTime?: string;
  recurrence: string[];
  timeZone: string[];
};

const seriesIdentityFor = (
  sourceId: string,
  entityHint: 'event' | 'group',
  fields: Record<string, unknown>,
): SeriesIdentity | undefined => {
  const names = normalizedIdentityValues(fields.title ?? fields.name);
  if (names.length === 0) return undefined;
  const recurrence = normalizedIdentityValues([
    fields.recurrenceLabel,
    fields.recurrenceLabels,
    fields.recurrence,
    fields.recurrenceRule,
  ]);
  const dateTime = localDateTimeFrom(fields.localStart, fields.timeZone);
  return {
    sourceId,
    entityHint,
    names,
    locations: normalizedIdentityValues([fields.location, fields.locationLabels]),
    ...(dateTime ? { localTime: dateTime.localTime } : {}),
    recurrence,
    timeZone: normalizedIdentityValues(fields.timeZone),
  };
};

const seriesKeyFrom = (identity: SeriesIdentity, recurrenceEvidence: string): string => {
  const digest = stableHash({
    version: 1,
    ...identity,
    recurrenceEvidence,
  });
  return `series:v1:${digest}`;
};

/**
 * A series key is emitted only when a normalized recurrence fact exists.
 * One-off events deliberately receive no date-free key, which avoids merging
 * unrelated events that happen to share a name, place, and clock time.
 */
export const recurringSeriesKeyFor = (
  sourceId: string,
  entityHint: 'event' | 'group',
  fields: Record<string, unknown>,
): string | undefined => {
  const identity = seriesIdentityFor(sourceId, entityHint, fields);
  if (!identity || identity.recurrence.length === 0) return undefined;
  return seriesKeyFrom(identity, 'EXPLICIT_RECURRENCE');
};

export type SeriesCandidateInput = {
  sourceItemKey: string;
  entityHint: 'event' | 'group' | 'organization' | 'venue';
  normalizedFields: Record<string, unknown>;
};

/**
 * Adds conservative run-level recurrence evidence for occurrence-oriented
 * sources (notably ICS). At least two distinct local dates must share the same
 * governed source, normalized name, exact normalized location, timezone, and
 * local clock time. Location or time variants intentionally remain separate.
 */
export const recurringSeriesKeysFor = (
  sourceId: string,
  candidates: readonly SeriesCandidateInput[],
): Map<string, string> => {
  const result = new Map<string, string>();
  const inferredGroups = new Map<string, {
    identity: SeriesIdentity;
    entries: Array<{ sourceItemKey: string; localDate: string }>;
  }>();

  for (const candidate of candidates) {
    if (candidate.entityHint !== 'event' && candidate.entityHint !== 'group') continue;
    const explicit = recurringSeriesKeyFor(sourceId, candidate.entityHint, candidate.normalizedFields);
    if (explicit) {
      result.set(candidate.sourceItemKey, explicit);
      continue;
    }
    if (candidate.entityHint !== 'event') continue;
    const dateTime = localDateTimeFrom(
      candidate.normalizedFields.localStart,
      candidate.normalizedFields.timeZone,
    );
    const identity = seriesIdentityFor(sourceId, candidate.entityHint, candidate.normalizedFields);
    if (!identity || !dateTime || !identity.localTime) continue;
    const groupKey = stableHash(identity);
    const group = inferredGroups.get(groupKey) ?? { identity, entries: [] };
    group.entries.push({ sourceItemKey: candidate.sourceItemKey, localDate: dateTime.localDate });
    inferredGroups.set(groupKey, group);
  }

  for (const group of inferredGroups.values()) {
    if (new Set(group.entries.map(entry => entry.localDate)).size < 2) continue;
    const key = seriesKeyFrom(group.identity, 'REPEATED_DISTINCT_LOCAL_DATES');
    group.entries.forEach(entry => result.set(entry.sourceItemKey, key));
  }
  return result;
};
