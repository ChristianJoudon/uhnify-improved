import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import { EmergencyState, HelpResources, RESOURCE_KINDS, RESOURCE_STATUSES } from './Help';
import { COUNTY_PRESS_RELEASES_URL, parseCountyNotices } from './countyNotices';

const requireAdmin = userId => {
  if (!userId || !Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'Only an administrator can change the help page.');
  }
};

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

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
