import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ManualSupportAdapter } from '../src/adapters/manual-support.js';
import {
  MATCHBOOK_CLASSIFICATION_TAXONOMY,
  recurringSeriesKeyFor,
  recurringSeriesKeysFor,
  suggestClassification,
  type ClassificationReason,
} from '../src/classification.js';
import { loadSourceRegistry } from '../src/source-registry.js';
import { syntheticSource } from './fixtures.js';

const EXPECTED_TAXONOMY = {
  outdoors: ['outdoor_recreation', 'fitness_movement', 'water_sports', 'nature_environment', 'spectator_sports'],
  music: ['live_music', 'dance_hula', 'theater_comedy', 'open_mic_karaoke', 'parade_performance'],
  books: ['classes_workshops', 'talks_discussions', 'books_writing', 'storytime_literacy', 'history_culture'],
  food: ['farmers_market', 'local_market', 'community_meals', 'food_drink', 'cooking'],
  art: ['arts_crafts', 'visual_art_exhibitions', 'film_photography', 'maker_technology'],
  community: ['civic_government', 'volunteer_service', 'business_networking', 'faith_spirituality', 'family_youth', 'senior_services', 'cultural_community'],
  support: ['addiction_recovery', 'family_addiction_support', 'mental_health_peer', 'mental_health_family', 'dementia_caregiver', 'caregiver_support', 'general_support'],
  wellness: ['yoga_meditation', 'health_wellness', 'keiki_family', 'kupuna_aging', 'gardening_home', 'parenting_playgroups'],
  night: ['festivals_fairs', 'nightlife_social', 'games_trivia', 'holiday_celebration'],
} as const;

const ALLOWED_REASONS = new Set<ClassificationReason>([
  'EXPLICIT_SUPPORT_TYPE',
  'SOURCE_CATEGORY_MATCH',
  'TITLE_MATCH',
  'DESCRIPTION_MATCH',
  'CONTEXT_MATCH',
  'SOURCE_PROFILE_MATCH',
  'FALLBACK_COMMUNITY',
]);

const suggestionFor = (
  normalizedFields: Record<string, unknown>,
  sourceProfile?: { displayName?: string; publisherName?: string; slug?: string },
) => {
  const source = syntheticSource();
  return suggestClassification({
    entityHint: 'event',
    normalizedFields,
    source: {
      id: source.id,
      slug: sourceProfile?.slug ?? source.slug,
      displayName: sourceProfile?.displayName ?? source.displayName,
      publisherName: sourceProfile?.publisherName ?? source.publisherName,
      contentKinds: source.contentKinds,
    },
  });
};

test('service taxonomy exactly matches the closed MatchBook review keys', () => {
  const actual = Object.fromEntries(Object.entries(MATCHBOOK_CLASSIFICATION_TAXONOMY)
    .map(([topicKey, topic]) => [topicKey, Object.keys(topic.subcategories)]));
  assert.deepEqual(actual, EXPECTED_TAXONOMY);
  assert.equal(MATCHBOOK_CLASSIFICATION_TAXONOMY.wellness.label, 'Family & Wellbeing');
  assert.equal(MATCHBOOK_CLASSIFICATION_TAXONOMY.food.subcategories.community_meals, 'Community meals');
});

test('title intent outranks noisy descriptions and source profiles in real practice examples', () => {
  const examples = [
    {
      fields: { title: 'Youth Summer Camp', description: 'Includes creative art and craft activities' },
      expected: ['wellness', 'keiki_family'],
    },
    {
      fields: { title: 'Grand Hyatt Luau', description: 'Book your dinner reservation' },
      expected: ['music', 'parade_performance'],
    },
    {
      fields: { title: 'Congregate Meals', description: 'Community program with weekly entertainment' },
      expected: ['food', 'community_meals'],
    },
    {
      fields: { title: 'Aloha Art Nights', description: 'Food and drink available at the market' },
      expected: ['art', 'visual_art_exhibitions'],
    },
    {
      fields: { title: 'NBTG Aloha Market' },
      source: { displayName: 'National Tropical Botanical Garden', publisherName: 'Botanical Garden' },
      expected: ['food', 'local_market'],
    },
    {
      fields: {
        title: 'National Tropical Botanical Garden Presents Aloha Market',
        description: 'Visit the botanical garden and discover tropical plants',
      },
      expected: ['food', 'local_market'],
    },
    {
      fields: { title: 'Barre', description: 'Weekly community class' },
      expected: ['outdoors', 'fitness_movement'],
    },
    {
      fields: { title: 'Community cleanup', location: 'Lydgate Beach' },
      expected: ['community', 'volunteer_service'],
    },
    {
      fields: { title: 'Lei workshop' },
      expected: ['art', 'arts_crafts'],
    },
    {
      fields: { title: 'Farmers market' },
      expected: ['food', 'farmers_market'],
    },
    {
      fields: { title: 'Kauaʻi Craft Fair', description: 'Annual holiday festival' },
      expected: ['food', 'local_market'],
    },
    {
      fields: { title: 'Garden Isle Quilters Quilt Exhibit & Sale' },
      expected: ['art', 'arts_crafts'],
    },
    {
      fields: { title: 'Writer’s Garden' },
      expected: ['books', 'books_writing'],
    },
    {
      fields: { title: 'Kauaʻi Food Forest' },
      expected: ['wellness', 'gardening_home'],
    },
    {
      fields: { title: 'Island Magic Mike' },
      expected: ['music', 'theater_comedy'],
    },
    {
      fields: { title: 'Kanikapila' },
      expected: ['music', 'live_music'],
    },
    {
      fields: { title: 'Club Night' },
      expected: ['night', 'nightlife_social'],
    },
    {
      fields: { title: 'Yoga Class' },
      expected: ['wellness', 'yoga_meditation'],
    },
    {
      fields: { title: 'Cooking Class' },
      expected: ['food', 'cooking'],
    },
    {
      fields: { title: 'Garden Island Dance' },
      expected: ['music', 'dance_hula'],
    },
    {
      fields: {
        title: 'Math Prep Week',
        sourceUrl: 'https://publisher.example/classes/math-prep-week',
      },
      expected: ['books', 'classes_workshops'],
    },
    {
      fields: {
        title: 'Kūpuna Jam Sessions',
        description: 'A welcoming music gathering for kūpuna.',
      },
      expected: ['music', 'live_music'],
    },
    {
      fields: { title: 'Akamu Organic Earth and Goods Market' },
      expected: ['food', 'local_market'],
    },
  ] as const;

  for (const example of examples) {
    const suggestion = suggestionFor(example.fields, 'source' in example ? example.source : undefined);
    assert.deepEqual(
      [suggestion.topicKey, suggestion.subcategoryKey],
      example.expected,
      example.fields.title,
    );
    assert.ok(suggestion.reasons.every(reason => ALLOWED_REASONS.has(reason)));
  }
});

test('classification uses publisher categories before prose, then safe item context and source paths', () => {
  const categoryLed = suggestionFor({
    title: 'Saturday gathering',
    categories: ['farmers market'],
    description: 'Includes a short yoga demonstration.',
    context: 'Kauaʻi food producers',
  });
  assert.deepEqual([categoryLed.topicKey, categoryLed.subcategoryKey], ['food', 'farmers_market']);
  assert.deepEqual(categoryLed.reasons, ['SOURCE_CATEGORY_MATCH']);
  assert.ok(categoryLed.confidence >= 0.85);

  const descriptionLed = suggestionFor({
    title: 'Morning practice',
    description: 'Guided yoga class and stretching for every experience level.',
    context: 'Lydgate Beach Park',
  });
  assert.deepEqual([descriptionLed.topicKey, descriptionLed.subcategoryKey], ['wellness', 'yoga_meditation']);
  assert.deepEqual(descriptionLed.reasons, ['DESCRIPTION_MATCH']);
  assert.ok(descriptionLed.confidence < categoryLed.confidence);

  const contextLed = suggestionFor({
    title: 'Island meetup',
    context: 'Live music at the community pavilion',
  });
  assert.deepEqual([contextLed.topicKey, contextLed.subcategoryKey], ['music', 'live_music']);
  assert.deepEqual(contextLed.reasons, ['CONTEXT_MATCH']);
  assert.ok(contextLed.confidence < descriptionLed.confidence);

  const sourceLed = suggestionFor({
    title: 'Weekly gathering',
    sourceUrl: 'https://publisher.example/calendar/open-mic',
  });
  assert.deepEqual([sourceLed.topicKey, sourceLed.subcategoryKey], ['music', 'open_mic_karaoke']);
  assert.deepEqual(sourceLed.reasons, ['SOURCE_PROFILE_MATCH']);
  assert.ok(sourceLed.confidence < contextLed.confidence);
});

test('ambiguous records use an explicit low-confidence community fallback', () => {
  assert.deepEqual(suggestionFor({
    title: 'Weekly gathering',
    privateNotes: 'This ignored field says concert and contains private context',
  }), {
    taxonomyVersion: 'matchbook-topics.v1',
    topicKey: 'community',
    subcategoryKey: 'cultural_community',
    confidence: 0.25,
    reasons: ['FALLBACK_COMMUNITY'],
  });
});

test('committed protected fixtures classify all 137 candidates without leaking source text into reasons', async () => {
  const registry = await loadSourceRegistry();
  const adapter = new ManualSupportAdapter();
  const counts = new Map<string, number>();
  let candidateCount = 0;

  for (const sourceId of ['SEN-001', 'SEN-002', 'SEN-003', 'SEN-004', 'SEN-005']) {
    const source = registry.sources.find(candidate => candidate.id === sourceId);
    assert.ok(source);
    const bytes = new Uint8Array(await readFile(new URL(`../fixtures/support/${sourceId}.json`, import.meta.url)));
    const extraction = await adapter.extract({
      bytes,
      mediaType: 'application/json',
      sourceUrl: source.publisherUrl,
      statusCode: 200,
      responseHeaders: {},
    }, source);
    const seriesKeys = recurringSeriesKeysFor(source.id, extraction.items);

    for (const item of extraction.items) {
      assert.ok(item.entityHint === 'event' || item.entityHint === 'group');
      const suggestion = suggestClassification({
        entityHint: item.entityHint,
        normalizedFields: item.normalizedFields,
        source,
      });
      const subtype = String(item.normalizedFields.supportSubtype);
      assert.equal(suggestion.topicKey, 'support');
      assert.equal(suggestion.subcategoryKey, subtype);
      assert.equal(suggestion.confidence, 0.99);
      assert.deepEqual(suggestion.reasons, ['EXPLICIT_SUPPORT_TYPE', 'SOURCE_CATEGORY_MATCH']);
      assert.match(seriesKeys.get(item.sourceItemKey) ?? '', /^series:v1:[a-f0-9]{64}$/);
      counts.set(subtype, (counts.get(subtype) ?? 0) + 1);
      candidateCount += 1;
    }
  }

  assert.equal(candidateCount, 137);
  assert.deepEqual(Object.fromEntries([...counts.entries()].sort()), {
    addiction_recovery: 113,
    dementia_caregiver: 6,
    family_addiction_support: 12,
    mental_health_family: 4,
    mental_health_peer: 2,
  });
});

test('explicit series keys are stable across occurrence dates and array order', () => {
  const first = recurringSeriesKeyFor('SRC-001', 'event', {
    title: 'Monday Gathering',
    localStart: '2026-08-10T18:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
    locationLabels: ['Main Hall', 'Līhuʻe'],
    recurrenceLabels: ['Mondays', 'Weekly'],
  });
  const next = recurringSeriesKeyFor('SRC-001', 'event', {
    title: '  monday gathering ',
    localStart: '2026-08-17T18:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
    locationLabels: ['Lihue', 'Main Hall'],
    recurrenceLabels: ['Weekly', 'Mondays'],
  });
  assert.match(first ?? '', /^series:v1:[a-f0-9]{64}$/);
  assert.equal(next, first);
  assert.equal(recurringSeriesKeyFor('SRC-001', 'event', {
    title: 'Monday Gathering',
    localStart: '2026-08-17T18:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
    locationLabels: ['Lihue', 'Main Hall'],
    recurrenceLabels: ['Weekly', 'Mondays'],
    privateContact: 'ignored@example.invalid',
    rawPayload: { secret: 'ignored' },
  }), first, 'unknown or private fields never enter the series identity');
  assert.notEqual(recurringSeriesKeyFor('SRC-001', 'event', {
    title: 'Monday Gathering',
    localStart: '2026-08-17T19:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
    locationLabels: ['Main Hall', 'Lihue'],
    recurrenceLabels: ['Mondays', 'Weekly'],
  }), first, 'local-time variants are intentionally separate');
  assert.notEqual(recurringSeriesKeyFor('SRC-001', 'event', {
    title: 'Monday Gathering',
    localStart: '2026-08-17T18:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
    location: 'Annex',
    recurrenceLabels: ['Mondays', 'Weekly'],
  }), first, 'location variants are intentionally separate');
  assert.notEqual(recurringSeriesKeyFor('SRC-002', 'event', {
    title: 'Monday Gathering',
    localStart: '2026-08-17T18:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
    locationLabels: ['Main Hall', 'Lihue'],
    recurrenceLabels: ['Mondays', 'Weekly'],
  }), first, 'different governed sources are not silently merged');
  assert.equal(recurringSeriesKeyFor('SRC-001', 'event', {
    title: 'One-time gathering',
    localStart: '2026-08-17T18:00:00-10:00',
    timeZone: 'Pacific/Honolulu',
  }), undefined);
});

test('run-level repeated occurrences receive a series key while true one-offs remain ungrouped', () => {
  const event = (
    sourceItemKey: string,
    localStart: string,
    location = 'Līhuʻe Library',
  ) => ({
    sourceItemKey,
    entityHint: 'event' as const,
    normalizedFields: {
      title: 'Monday Gathering',
      localStart,
      location,
      timeZone: 'Pacific/Honolulu',
    },
  });
  const items = [
    event('main-1', '2026-08-11T04:00:00.000Z'),
    event('main-2', '2026-08-18T04:00:00.000Z'),
    event('annex-1', '2026-08-12T04:00:00.000Z', 'Library Annex'),
    event('annex-2', '2026-08-19T04:00:00.000Z', 'Library Annex'),
    event('later-1', '2026-08-11T05:00:00.000Z'),
    event('later-2', '2026-08-18T05:00:00.000Z'),
    {
      sourceItemKey: 'one-off',
      entityHint: 'event' as const,
      normalizedFields: {
        title: 'Single Concert',
        localStart: '2026-08-22T19:00:00-10:00',
        location: 'Main Hall',
        timeZone: 'Pacific/Honolulu',
      },
    },
    event('same-day-duplicate-a', '2026-08-25T04:00:00.000Z', 'Duplicate Room'),
    event('same-day-duplicate-b', '2026-08-25T04:00:00.000Z', 'Duplicate Room'),
  ];
  const keys = recurringSeriesKeysFor('SRC-003', items);

  assert.equal(keys.get('main-1'), keys.get('main-2'));
  assert.match(keys.get('main-1') ?? '', /^series:v1:[a-f0-9]{64}$/);
  assert.equal(keys.get('annex-1'), keys.get('annex-2'));
  assert.notEqual(keys.get('annex-1'), keys.get('main-1'));
  assert.equal(keys.get('later-1'), keys.get('later-2'));
  assert.notEqual(keys.get('later-1'), keys.get('main-1'));
  assert.equal(keys.has('one-off'), false);
  assert.equal(keys.has('same-day-duplicate-a'), false);
  assert.equal(keys.has('same-day-duplicate-b'), false);
});
