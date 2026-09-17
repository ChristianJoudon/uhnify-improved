// First, and that order is load-bearing: the guard refuses to start a
// production process on the development settings, and it must say so BEFORE
// Accounts creates the default users from those settings — a refusal that
// arrives after `admin@foo.com / changeme` is already in the database has not
// guarded anything.
import '/imports/startup/server/productionGuard';
import { Meteor } from 'meteor/meteor';
// Before Accounts, so the rule about what an account may be called is already
// in force for the first account that file creates.
import '/imports/startup/server/accountRules';
import '/imports/startup/server/Accounts';
// Registers nothing at all unless this is a development server whose settings
// list the development accounts; see the file for the four fences around it.
import '/imports/startup/server/devSignIn';
import '/imports/startup/server/securityHeaders';
// Serves uploaded photos from /photo/…, which is where every listing's image
// path now points. Without it each of those is a broken image.
import '/imports/startup/server/photoRoute';
import '/imports/startup/server/Publications';
import '/imports/startup/server/CommunityIngestion';
import '/imports/startup/server/CommunityIngestionRunQueue';
import '/imports/startup/server/IngestionResearchQueue';
import '/imports/startup/server/IngestionReviewActions';
import '/imports/startup/server/Mongo';
import '/imports/startup/both/Methods';
// Last, and that order is load-bearing: this wraps the handler table Methods.js
// has just filled in. Imported earlier it would wrap nothing.
import { installAuditTrail } from '/imports/startup/server/auditTrail';
import { installRateLimits } from '/imports/startup/server/rateLimits';

Meteor.startup(() => {
  const wrapped = installAuditTrail();
  console.log(`[audit] recording ${wrapped} methods.`);
  console.log(`[limits] ${installRateLimits()} rules in force.`);
});
