import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import {
  AREA_LEVELS,
  BRIEFING_SECTIONS,
  EmergencyState,
  HelpBriefing,
  HelpBriefingItems,
  HelpResources,
  RESOURCE_KINDS,
  RESOURCE_STATUSES,
} from './Help';
import { COUNTY_PRESS_RELEASES_URL, parseCountyNotices } from './countyNotices';

export const BRIEFING_EXAMPLE_ASSET = 'help-briefing-example.json';

const requireAdmin = userId => {
  if (!userId || !Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'Only an administrator can change the help page.');
  }
};

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const httpsUrl = value => (/^https:\/\//.test(text(value, 500)) ? text(value, 500) : '');

/**
 * One item of the situation report, from whatever the form sent, in the
 * shape the schema takes — with the fields of other sections dropped, so an
 * area that becomes a question does not carry its road note along.
 */
const briefingFields = (doc, userId) => {
  const section = BRIEFING_SECTIONS.some(known => known.value === doc.section) ? doc.section : null;
  if (!section) {
    throw new Meteor.Error('invalid-section', 'Pick which part of the report this belongs to.');
  }
  const title = text(doc.title, 160);
  if (!title) {
    throw new Meteor.Error('required', section === 'question' ? 'Write the question.' : 'Give it a title.');
  }
  const url = httpsUrl(doc.url);
  if (section === 'link' && !url) {
    throw new Meteor.Error('required', 'An official update is a link; give its https address.');
  }
  const fields = {
    section,
    title,
    headline: '',
    details: '',
    gettingAround: '',
    powerWater: '',
    beachesParks: '',
    recheck: '',
    url,
    sourceLabel: section === 'link' ? '' : text(doc.sourceLabel, 120),
    publicationStatus: 'published',
    updatedAt: new Date(),
    updatedBy: userId,
  };
  if (section === 'glance') {
    fields.headline = text(doc.headline, 200);
    fields.details = text(doc.details, 2000);
  } else if (section === 'area') {
    fields.headline = text(doc.headline, 200);
    fields.gettingAround = text(doc.gettingAround, 500);
    fields.powerWater = text(doc.powerWater, 500);
    fields.beachesParks = text(doc.beachesParks, 500);
    fields.level = AREA_LEVELS.some(known => known.value === doc.level) ? doc.level : AREA_LEVELS[0].value;
  } else if (section === 'ahead') {
    fields.details = text(doc.details, 2000);
    fields.recheck = text(doc.recheck, 200);
  } else if (section === 'question') {
    fields.details = text(doc.details, 2000);
  }
  return fields;
};

/** After the last item of the section, or where the form said. */
const briefingOrder = (doc, section) => {
  if (Number.isFinite(doc.order)) {
    return Math.max(0, Math.round(doc.order));
  }
  const last = HelpBriefingItems.collection.findOne({ section, publicationStatus: 'published' }, { sort: { order: -1 } });
  return last ? last.order + 1 : 1;
};

/** A GET over Node's own https, because the server has no fetch on Node 14 and
    nothing here justifies a package. Bounded: eight seconds, two megabytes. */
const getText = url => new Promise((resolve, reject) => {
  // Not an import: this file loads in the browser too, where there is no https.
  // eslint-disable-next-line global-require
  const https = require('https');
  const request = https.get(url, {
    // The same name the ingestion worker gives, which the county's server
    // accepts. It refuses some strings with a 403 — a plain-English one with
    // spaces was turned away — so this is not the place to be creative.
    headers: { 'user-agent': 'MatchBookCommunityRegister/0.2 (+https://christianjoudon.github.io/work/matchbook.html)', accept: 'text/html' },
    timeout: 8000,
  }, response => {
    if (response.statusCode !== 200) {
      response.resume();
      reject(new Error(`HTTP ${response.statusCode}`));
      return;
    }
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        response.destroy(new Error('too large'));
      }
    });
    response.on('end', () => resolve(body));
  });
  request.on('timeout', () => request.destroy(new Error('timed out')));
  request.on('error', reject);
});

/** One fetch every fifteen minutes however many people open the page. */
const cache = { at: 0, notices: null };
const NOTICE_TTL_MS = 15 * 60 * 1000;

Meteor.methods({
  'help.upsertResource'(doc) {
    check(doc, Object);
    requireAdmin(this.userId);
    const kind = RESOURCE_KINDS.some(known => known.value === doc.kind) ? doc.kind : null;
    if (!kind) {
      throw new Meteor.Error('invalid-kind', 'Pick what this place gives.');
    }
    const name = text(doc.name, 160);
    if (!name) {
      throw new Meteor.Error('required', 'Give it a name.');
    }
    const status = RESOURCE_STATUSES.includes(doc.status) ? doc.status : 'unknown';
    const source = {
      ...(text(doc.sourcePublisher, 120) ? { publisher: text(doc.sourcePublisher, 120) } : {}),
      ...(/^https:\/\//.test(text(doc.sourceUrl, 500)) ? { url: text(doc.sourceUrl, 500) } : {}),
    };
    const fields = {
      kind,
      name,
      details: text(doc.details, 2000),
      location: text(doc.location, 240),
      region: text(doc.region, 80),
      hours: text(doc.hours, 200),
      status,
      source,
      verifiedAt: new Date(),
      publicationStatus: 'published',
      updatedAt: new Date(),
      updatedBy: this.userId,
    };
    if (typeof doc._id === 'string' && doc._id) {
      HelpResources.collection.update(doc._id, { $set: fields });
      return doc._id;
    }
    return HelpResources.collection.insert({ ...fields, createdAt: new Date() });
  },

  /** "Still true as of now": the one-tap check an administrator does on a round. */
  'help.setResourceStatus'(resourceId, status) {
    check(resourceId, String);
    check(status, String);
    requireAdmin(this.userId);
    if (!RESOURCE_STATUSES.includes(status)) {
      throw new Meteor.Error('invalid-status', 'Open, closed, or unknown.');
    }
    return HelpResources.collection.update(resourceId, {
      $set: { status, verifiedAt: new Date(), updatedAt: new Date(), updatedBy: this.userId },
    });
  },

  'help.removeResource'(resourceId) {
    check(resourceId, String);
    requireAdmin(this.userId);
    return HelpResources.collection.update(resourceId, {
      $set: { publicationStatus: 'archived', updatedAt: new Date(), updatedBy: this.userId },
    });
  },

  /** The banner on every page: on with a headline, or off. */
  'help.setEmergency'(state) {
    check(state, { active: Boolean, headline: Match.Optional(String), message: Match.Optional(String) });
    requireAdmin(this.userId);
    const headline = text(state.headline, 120);
    if (state.active && !headline) {
      throw new Meteor.Error('required', 'Say what is happening — that is the banner.');
    }
    EmergencyState.collection.upsert(EmergencyState.id, {
      $set: {
        active: state.active,
        headline,
        message: text(state.message, 500),
        updatedAt: new Date(),
        updatedBy: this.userId,
      },
    });
    return state.active;
  },

  /** The report's header: on with a title, or off. The items stay either way. */
  'help.setBriefing'(state) {
    check(state, { active: Boolean, title: Match.Optional(String), lead: Match.Optional(String), note: Match.Optional(String) });
    requireAdmin(this.userId);
    const title = text(state.title, 120);
    if (state.active && !title) {
      throw new Meteor.Error('required', 'Name the situation — that is the report’s title.');
    }
    HelpBriefing.collection.upsert(HelpBriefing.id, {
      $set: {
        active: state.active,
        title,
        lead: text(state.lead, 400),
        note: text(state.note, 300),
        updatedAt: new Date(),
        updatedBy: this.userId,
      },
    });
    return state.active;
  },

  'help.upsertBriefingItem'(doc) {
    check(doc, Object);
    requireAdmin(this.userId);
    const fields = briefingFields(doc, this.userId);
    fields.order = briefingOrder(doc, fields.section);
    if (typeof doc._id === 'string' && doc._id) {
      HelpBriefingItems.collection.update(doc._id, {
        $set: fields,
        // An area that becomes something else must not keep its colour.
        ...(fields.section === 'area' ? {} : { $unset: { level: 1 } }),
      });
      return doc._id;
    }
    return HelpBriefingItems.collection.insert({ ...fields, createdAt: new Date() });
  },

  'help.removeBriefingItem'(itemId) {
    check(itemId, String);
    requireAdmin(this.userId);
    return HelpBriefingItems.collection.update(itemId, {
      $set: { publicationStatus: 'archived', updatedAt: new Date(), updatedBy: this.userId },
    });
  },

  /**
   * The worked example from private/, as a starting point — the areas are
   * the same areas every time, and a form of forty empty rows is where a
   * report goes to not get written. Only into an empty report, and it does
   * not switch the report on: every line is somebody else's September, and
   * the administrator reads it before the island does.
   */
  'help.loadBriefingExample'() {
    requireAdmin(this.userId);
    if (!Meteor.isServer) {
      return 0;
    }
    if (HelpBriefingItems.collection.find({ publicationStatus: 'published' }).count() > 0) {
      throw new Meteor.Error('not-empty', 'The report already has items. Remove them first if you want the example.');
    }
    // `Assets` is a server global in Meteor 2.x, not an importable package.
    const example = JSON.parse(Assets.getText(BRIEFING_EXAMPLE_ASSET));
    const now = new Date();
    const counts = {};
    example.items.forEach(item => {
      counts[item.section] = (counts[item.section] || 0) + 1;
      HelpBriefingItems.collection.insert({ ...briefingFields(item, this.userId), order: counts[item.section], createdAt: now });
    });
    const current = HelpBriefing.collection.findOne(HelpBriefing.id);
    if (!current || !current.title) {
      HelpBriefing.collection.upsert(HelpBriefing.id, {
        $set: { active: false, ...example.briefing, updatedAt: now, updatedBy: this.userId },
      });
    }
    return example.items.length;
  },

  /** The county's newest releases, cached; [] when the county cannot be reached. */
  async 'help.countyNotices'() {
    if (!Meteor.isServer) {
      return [];
    }
    if (cache.notices && Date.now() - cache.at < NOTICE_TTL_MS) {
      return cache.notices;
    }
    try {
      const html = await getText(COUNTY_PRESS_RELEASES_URL);
      cache.notices = parseCountyNotices(html);
      cache.at = Date.now();
    } catch (error) {
      // Stale is better than nothing during an outage, and nothing is better
      // than a guess; an empty list is what the page shows as "could not reach".
      if (!cache.notices) {
        return [];
      }
    }
    return cache.notices;
  },
});
