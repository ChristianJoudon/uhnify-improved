/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { EmergencyState, HelpBriefing, HelpBriefingItems, HelpResources } from './Help';
import { parseCountyNotices } from './countyNotices';
import { callAs, errorFrom, makeUser, resetAll } from '../../startup/server/testFixtures';

const PAGE = `
<div class="list-container"><div class="list-item-container"><article>
<a href="https://www.kauai.gov/County-Press-Releases/Sept.-17-Recovery-Update" >
<h2 class="list-item-title"> Sept. 17, 4:00 p.m., County of Kaua&#39;i, Hurricane Lowell Recovery </h2>
<p class='oc-thumbnail-image'><img src="x.png" alt=""/></p>
<p class="published-on small-text">Published on September 17, 2026</p>
<p> LĪHUʻE – Kauaʻi continues its recovery from Hurricane Lowell. </p>
</article></div>
<div class="list-item-container"><article>
<a href="https://www.kauai.gov/Somewhere-Else/Not-a-release"><h2 class="list-item-title">Ignore me</h2></a>
</article></div>
<div class="list-item-container"><article>
<a href="https://www.kauai.gov/County-Press-Releases/DOW-notice"><h2 class="list-item-title">Water notice lifted</h2></a>
<p class="published-on small-text">Published on Sept. 16, 2026</p>
</article></div></div>`;

if (Meteor.isServer) {
  describe('the help page', function () {
    let admin;
    let member;
    beforeEach(function () {
      resetAll();
      HelpResources.collection.remove({});
      EmergencyState.collection.remove({});
      HelpBriefing.collection.remove({});
      HelpBriefingItems.collection.remove({});
      admin = makeUser({ admin: true });
      member = makeUser();
    });

    it('builds the situation report a line at a time, each in its section’s shape, and only for an administrator', function () {
      const area = {
        section: 'area',
        title: 'Hanalei',
        level: 'restricted',
        headline: 'Local traffic only.',
        gettingAround: 'Bridge lane closed.',
        powerWater: 'Conserve water.',
        details: 'should be dropped',
        sourceLabel: 'County update',
        url: 'https://www.kauai.gov/County-Press-Releases',
      };
      assert.equal(errorFrom(() => callAs(member, 'help.upsertBriefingItem', area)), 'not-authorized');
      assert.equal(errorFrom(() => callAs(admin, 'help.upsertBriefingItem', { ...area, section: 'weather' })), 'invalid-section');
      assert.equal(errorFrom(() => callAs(admin, 'help.upsertBriefingItem', { ...area, title: '' })), 'required');
      assert.equal(errorFrom(() => callAs(admin, 'help.upsertBriefingItem', { section: 'link', title: 'KIUC', url: 'http://kiuc.coop' })), 'required');

      const first = callAs(admin, 'help.upsertBriefingItem', area);
      const second = callAs(admin, 'help.upsertBriefingItem', { section: 'area', title: 'Poʻipū', level: 'nonsense' });
      const stored = HelpBriefingItems.collection.findOne(first);
      assert.equal(stored.level, 'restricted');
      assert.notOk(stored.details, 'a field of another section is dropped');
      assert.equal(stored.order, 1);
      assert.equal(HelpBriefingItems.collection.findOne(second).level, 'interruptions', 'an unknown level is the lightest');
      assert.equal(HelpBriefingItems.collection.findOne(second).order, 2, 'new lines go last in their section');

      // Turned into a question, it loses its colour and its road note.
      callAs(admin, 'help.upsertBriefingItem', { _id: first, section: 'question', title: 'Can I reach Hanalei?', details: 'Local traffic only.', order: 5 });
      const asked = HelpBriefingItems.collection.findOne(first);
      assert.equal(asked.section, 'question');
      assert.isUndefined(asked.level);
      assert.notOk(asked.gettingAround);
      assert.equal(asked.order, 5);
      assert.equal(HelpBriefingItems.collection.find({}).count(), 2);

      callAs(admin, 'help.removeBriefingItem', second);
      assert.equal(HelpBriefingItems.collection.findOne(second).publicationStatus, 'archived');
    });

    it('turns the report on with a title, and loads the example only into an empty report without turning it on', function () {
      assert.equal(errorFrom(() => callAs(admin, 'help.setBriefing', { active: true, title: ' ' })), 'required');
      assert.equal(errorFrom(() => callAs(member, 'help.loadBriefingExample')), 'not-authorized');
      const loaded = callAs(admin, 'help.loadBriefingExample');
      assert.isAbove(loaded, 30);
      assert.equal(HelpBriefingItems.collection.find({ publicationStatus: 'published' }).count(), loaded);
      assert.equal(HelpBriefingItems.collection.find({ section: 'area' }).count(), 12);
      assert.deepEqual(HelpBriefingItems.collection.find({ section: 'area' }, { sort: { order: 1 } }).map(item => item.order).slice(0, 3), [1, 2, 3]);
      assert.isTrue(HelpBriefingItems.collection.find({ section: 'link' }).fetch().every(item => /^https:\/\//.test(item.url)));
      const header = HelpBriefing.collection.findOne(HelpBriefing.id);
      assert.isFalse(header.active, 'the example never goes live by itself');
      assert.equal(header.title, 'Hurricane Lowell recovery');
      assert.equal(errorFrom(() => callAs(admin, 'help.loadBriefingExample')), 'not-empty');

      callAs(admin, 'help.setBriefing', { active: true, title: 'Lowell recovery', lead: 'Conserve water.', note: 'Dates move.' });
      const on = HelpBriefing.collection.findOne(HelpBriefing.id);
      assert.isTrue(on.active);
      assert.equal(on.lead, 'Conserve water.');
      callAs(admin, 'help.setBriefing', { active: false, title: 'Lowell recovery' });
      assert.isFalse(HelpBriefing.collection.findOne(HelpBriefing.id).active);
      assert.equal(HelpBriefingItems.collection.find({ publicationStatus: 'published' }).count(), loaded, 'turning it off keeps the lines');
    });

    it('reads the county’s press-release index: title, link, date, first paragraph — and only releases', function () {
      const notices = parseCountyNotices(PAGE);
      assert.equal(notices.length, 2);
      assert.equal(notices[0].title, 'Sept. 17, 4:00 p.m., County of Kaua’i, Hurricane Lowell Recovery');
      assert.equal(notices[0].url, 'https://www.kauai.gov/County-Press-Releases/Sept.-17-Recovery-Update');
      assert.equal(notices[0].publishedOn.toISOString().slice(0, 10), '2026-09-17');
      assert.match(notices[0].summary, /^LĪHUʻE – Kauaʻi continues/);
      assert.equal(notices[1].publishedOn.toISOString().slice(0, 10), '2026-09-16');
      assert.equal(notices[1].summary, '');
      assert.deepEqual(parseCountyNotices('<html>template changed</html>'), []);
    });

    it('lets an administrator, and nobody else, post a place, check it, and take it off', function () {
      const place = { kind: 'water', name: 'Kapaʻa Neighborhood Center', location: '4491 Kou St, Kapaʻa', hours: 'Daily 8–4', status: 'open', sourcePublisher: 'County of Kauaʻi', sourceUrl: 'https://www.kauai.gov/x' };
      assert.equal(errorFrom(() => callAs(member, 'help.upsertResource', place)), 'not-authorized');
      assert.equal(errorFrom(() => callAs(null, 'help.upsertResource', place)), 'not-authorized');
      assert.equal(errorFrom(() => callAs(admin, 'help.upsertResource', { ...place, kind: 'gold' })), 'invalid-kind');
      assert.equal(errorFrom(() => callAs(admin, 'help.upsertResource', { ...place, name: ' ' })), 'required');
      const id = callAs(admin, 'help.upsertResource', place);
      const stored = HelpResources.collection.findOne(id);
      assert.equal(stored.publicationStatus, 'published');
      assert.instanceOf(stored.verifiedAt, Date);
      assert.deepEqual(stored.source, { publisher: 'County of Kauaʻi', url: 'https://www.kauai.gov/x' });
      assert.equal(errorFrom(() => callAs(member, 'help.setResourceStatus', id, 'closed')), 'not-authorized');
      callAs(admin, 'help.setResourceStatus', id, 'closed');
      assert.equal(HelpResources.collection.findOne(id).status, 'closed');
      assert.equal(errorFrom(() => callAs(admin, 'help.setResourceStatus', id, 'gone')), 'invalid-status');
      callAs(admin, 'help.removeResource', id);
      assert.equal(HelpResources.collection.findOne(id).publicationStatus, 'archived');
    });

    it('drops a source page that is not https, and an edit keeps the same record', function () {
      const id = callAs(admin, 'help.upsertResource', { kind: 'ice', name: 'Ice at the park', sourceUrl: 'http://plain.example', status: 'open' });
      assert.deepEqual(HelpResources.collection.findOne(id).source, {});
      const same = callAs(admin, 'help.upsertResource', { _id: id, kind: 'ice', name: 'Ice at the park (moved)', status: 'open' });
      assert.equal(same, id);
      assert.equal(HelpResources.collection.find({}).count(), 1);
      assert.equal(HelpResources.collection.findOne(id).name, 'Ice at the park (moved)');
    });

    it('turns the banner on with a headline, refuses one without, and turns it off', function () {
      assert.equal(errorFrom(() => callAs(member, 'help.setEmergency', { active: true, headline: 'Storm' })), 'not-authorized');
      assert.equal(errorFrom(() => callAs(admin, 'help.setEmergency', { active: true, headline: '  ' })), 'required');
      callAs(admin, 'help.setEmergency', { active: true, headline: 'Hurricane Lowell recovery', message: 'Water is on daily.' });
      const state = EmergencyState.collection.findOne(EmergencyState.id);
      assert.isTrue(state.active);
      assert.equal(state.headline, 'Hurricane Lowell recovery');
      callAs(admin, 'help.setEmergency', { active: false });
      assert.isFalse(EmergencyState.collection.findOne(EmergencyState.id).active);
    });
  });
}
