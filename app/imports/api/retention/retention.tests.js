/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { ensureTtlIndex, retentionDays, retentionSeconds } from './retention';

/**
 * These assert that the index MongoDB holds is the one the settings ask for.
 * They do not wait for the TTL monitor to delete anything: that is MongoDB's
 * behaviour, it runs once a minute, and a test of it would be a test of them.
 */
if (Meteor.isServer) {
  describe('retention', function () {
    this.timeout(10000);

    let original;

    beforeEach(function () {
      original = Meteor.settings.retention;
    });

    afterEach(function () {
      Meteor.settings.retention = original;
    });

    it('defaults to eighteen months of behaviour and a year of audit', function () {
      delete Meteor.settings.retention;
      assert.equal(retentionDays('behaviourDays'), 548);
      assert.equal(retentionDays('auditDays'), 365);
      assert.equal(retentionSeconds('auditDays'), 365 * 24 * 60 * 60);
    });

    it('takes a configured number of days', function () {
      Meteor.settings.retention = { behaviourDays: 90, auditDays: '30' };
      assert.equal(retentionDays('behaviourDays'), 90);
      assert.equal(retentionDays('auditDays'), 30);
    });

    /** Zero would empty the log within a minute of boot; nonsense would leave
        it with no limit at all. Neither is what a typo should cost. */
    it('falls back to the default rather than apply a limit that is not one', function () {
      Meteor.settings.retention = { behaviourDays: 0, auditDays: 'a year' };
      assert.equal(retentionDays('behaviourDays'), 548);
      assert.equal(retentionDays('auditDays'), 365);
    });

    describe('ensureTtlIndex', function () {
      const scratch = new Mongo.Collection('RetentionIndexScratch');
      const ttlIndex = async () => (await scratch.rawCollection().indexes())
        .find(index => index.key.stamp === 1);

      beforeEach(async function () {
        await scratch.rawCollection().drop().catch(() => {});
      });

      it('creates the index on a collection that does not exist yet', async function () {
        assert.equal(await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 600 }), 'created');
        assert.equal((await ttlIndex()).expireAfterSeconds, 600);
      });

      it('leaves a matching index alone', async function () {
        await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 600 });
        assert.equal(await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 600 }), 'unchanged');
      });

      /** The failure this exists for: createIndex refuses, one line is logged,
          and the old schedule goes on applying for good. */
      it('changes the expiry of an index that already exists', async function () {
        await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 600 });
        assert.equal(await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 1200 }), 'changed');
        assert.equal((await ttlIndex()).expireAfterSeconds, 1200);
      });

      it('keeps the partial filter, and refuses an index that covers something else', async function () {
        const partialFilterExpression = { derived: { $exists: true } };
        await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 600, partialFilterExpression });
        assert.deepEqual((await ttlIndex()).partialFilterExpression, partialFilterExpression);

        let refusal = null;
        await ensureTtlIndex({ collection: scratch, field: 'stamp', seconds: 600 }).catch(error => {
          refusal = error;
        });
        assert.match(refusal?.message, /different partial filter/);
      });
    });
  });
}
