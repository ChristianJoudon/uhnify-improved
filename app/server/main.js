import { Meteor } from 'meteor/meteor';
import '/imports/startup/server/Accounts';
import '/imports/startup/server/Publications';
import '/imports/startup/server/Mongo';
import '/imports/startup/both/Methods';
// Last, and that order is load-bearing: this wraps the handler table Methods.js
// has just filled in. Imported earlier it would wrap nothing.
import { installAuditTrail } from '/imports/startup/server/auditTrail';

Meteor.startup(() => {
  const wrapped = installAuditTrail();
  console.log(`[audit] recording ${wrapped} methods.`);
});
