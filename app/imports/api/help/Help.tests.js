/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { EmergencyState, HelpResources } from './Help';
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
      admin = makeUser({ admin: true });
      member = makeUser();
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
