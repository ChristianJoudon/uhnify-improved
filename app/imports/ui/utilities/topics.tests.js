/* eslint-env mocha */
import { assert } from 'chai';
import {
  ACTIVITIES,
  ACTIVITY_FAMILIES,
  ACTIVITY_KEYS,
  INTEREST_TOPIC_KEYS,
  TOPICS,
  TOPIC_KEYS,
  activityFor,
  topicFor,
  topicForClub,
  topicForEvent,
} from './topics';

describe('activity icon taxonomy', function () {
  it('registers every supplied icon once under the existing topic system', function () {
    assert.lengthOf(ACTIVITY_KEYS, 46);
    assert.lengthOf(new Set(ACTIVITY_KEYS), 46);
    assert.sameMembers(
      Object.values(ACTIVITY_FAMILIES).flat(),
      ACTIVITY_KEYS,
    );
    assert.sameMembers(TOPIC_KEYS, [
      'outdoors', 'music', 'books', 'food', 'art', 'community', 'support', 'wellness', 'night',
    ]);

    const iconPaths = ACTIVITY_KEYS.map(key => ACTIVITIES[key].icon);
    assert.lengthOf(new Set(iconPaths), 46);
    assert.lengthOf(iconPaths.filter(path => path.startsWith('/images/activity-icons/')), 44);
    assert.sameMembers(
      iconPaths.filter(path => path.startsWith('/images/motifs/')),
      ['/images/motifs/art.png', '/images/motifs/running-spare.png'],
    );
    ACTIVITY_KEYS.forEach(key => {
      const item = ACTIVITIES[key];
      assert.include(TOPIC_KEYS, item.topicKey);
      assert.match(item.icon, /^\/images\/(activity-icons|motifs)\/[a-z0-9-]+\.png$/);
      assert.lengthOf(item.fields, 2);
      assert.match(item.field, /^linear-gradient\(/);
      assert.include(item.fields, item.field);
      assert.match(item.chip, /^#[0-9a-f]{6}$/i);
      assert.match(item.chipInk, /^#[0-9a-f]{6}$/i);
      assert.equal(item.ink, '#303234');
    });
  });

  it('uses existing reviewed topics while resolving the most specific supplied art', function () {
    const market = topicForEvent({
      topicIds: ['food'],
      categories: ['food', 'farmers_market'],
      title: 'Saturday market',
    });
    assert.equal(market.key, 'food');
    assert.equal(market.activityKey, 'farmers_market_stall');
    assert.equal(market.icon, '/images/activity-icons/farmers-market-stall.png');

    const dance = topicForEvent({
      topicIds: ['music'],
      categories: ['music', 'dance_hula'],
      title: 'Hula class',
    });
    assert.equal(dance.key, 'music');
    assert.equal(dance.activityKey, 'dance_class');

    const ceramics = topicForClub({
      categories: ['art'],
      name: 'Tuesday Pottery Circle',
    });
    assert.equal(ceramics.key, 'art');
    assert.equal(ceramics.activityKey, 'pottery');

    const yoga = topicForEvent({ title: 'Sunrise Yoga & Stretching' });
    assert.equal(yoga.key, 'wellness');
    assert.equal(yoga.activityKey, 'yoga_stretch');
    assert.equal(ACTIVITIES.yoga_stretch.topicKey, 'wellness');
    assert.equal(ACTIVITIES.yoga_stretch.family, 'Wellbeing & Family');
    assert.equal(TOPICS.outdoors.match.includes('yoga'), false);

    const lululemon = topicForEvent({ title: 'Lululemon Sunday Sweat' });
    assert.equal(lululemon.key, 'wellness');
    assert.equal(lululemon.activityKey, 'yoga_stretch');
  });

  it('lets specific event names choose art without overriding their reviewed topic', function () {
    const cases = [
      ['Writer’s Garden', 'writing_journaling', '/images/activity-icons/writing-journaling.png'],
      ['Kauaʻi Marathon and Half Marathon', 'running', '/images/motifs/running-spare.png'],
      ['Kauaʻi Made Craft Fair', 'craft_circle', '/images/motifs/art.png'],
      ['Tuesday Bridge', 'card_games', '/images/activity-icons/card-games.png'],
      ['Cantonese Mahjong', 'card_games', '/images/activity-icons/card-games.png'],
      ['The Rocky Horror Picture Show', 'movie_night', '/images/activity-icons/movie-night.png'],
      ['Goodwill Reuse Collection Events', 'swap_exchange', '/images/activity-icons/swap-exchange.png'],
      ['Mokihana Berry Read-Aloud Club', 'reading_storytime', '/images/activity-icons/reading-storytime.png'],
      ['YWCA Kauaʻi Hula Lessons', 'dance_class', '/images/activity-icons/dance-class.png'],
    ];

    cases.forEach(([title, activityKey, icon]) => {
      const event = topicForEvent({
        title,
        topicIds: ['community'],
        categories: ['volunteer_service'],
      });
      assert.equal(event.key, 'community');
      assert.equal(event.activityKey, activityKey);
      assert.equal(event.icon, icon);
    });
  });

  it('can classify a future granular subsection without adding another topic', function () {
    assert.equal(activityFor('birdwatching').key, 'birdwatching');
    const future = topicForEvent({ categories: ['birdwatching'], title: 'Morning outing' });
    assert.equal(future.key, 'outdoors');
    assert.equal(future.activityKey, 'birdwatching');
  });

  it('keeps broad topic covers in the same design family', function () {
    TOPIC_KEYS.forEach(key => {
      assert.match(TOPICS[key].icon, /^\/images\/activity-icons\//);
    });
    assert.equal(TOPICS.art.icon, '/images/activity-icons/pottery.png');
    assert.equal(TOPICS.night.icon, '/images/activity-icons/language-exchange.png');
  });
});

describe('support group topic', function () {
  it('classifies the canonical category for events and clubs', function () {
    assert.equal(topicForEvent({ title: 'Tuesday meeting', categories: ['support_group'] }).key, 'support');
    assert.equal(topicForClub({ name: 'Peer circle', categories: ['support_group'] }).key, 'support');
  });

  it('does not treat generic support language as participation in a support group', function () {
    assert.notEqual(topicFor('Support local growers at the market').key, 'support');
    assert.notEqual(topicFor(['community'], 'A fundraiser supporting the library').key, 'support');
  });

  it('keeps support browseable but out of profile-interest choices', function () {
    assert.include(TOPIC_KEYS, 'support');
    assert.notInclude(INTEREST_TOPIC_KEYS, 'support');
  });

  it('does not expose a title-derived activity illustration on a support listing', function () {
    const support = topicForEvent({
      topicIds: ['support'],
      categories: ['support_group'],
      title: 'Recovery yoga peer circle',
    });
    assert.equal(support.key, 'support');
    assert.isNull(support.activityKey);
    assert.equal(support.icon, TOPICS.support.icon);
  });

  it('keeps a reviewed topic authoritative over ambiguous title words', function () {
    const event = {
      title: 'Youth Summer Camp',
      categories: ['Family & Wellbeing', 'Keiki & family'],
      topicIds: ['wellness'],
    };
    assert.equal(topicForEvent(event).key, 'wellness');
  });
});
