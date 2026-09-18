import { Meteor } from 'meteor/meteor';
import { EmergencyState, HelpBriefing, HelpBriefingItems, HelpResources } from '../../api/help/Help';

/** Public, all of them: the help page must work for somebody who has never
    signed up and whose phone is on one bar. */
Meteor.publish(HelpResources.publicationName, function () {
  return HelpResources.collection.find(
    { publicationStatus: 'published' },
    { fields: { updatedBy: 0 }, sort: { kind: 1, status: 1, name: 1 } },
  );
});

Meteor.publish(EmergencyState.publicationName, function () {
  return EmergencyState.collection.find({ _id: EmergencyState.id }, { fields: { updatedBy: 0 } });
});

Meteor.publish(HelpBriefing.publicationName, function () {
  return HelpBriefing.collection.find({ _id: HelpBriefing.id }, { fields: { updatedBy: 0 } });
});

/** The items go out whether the report is on or off: the administrator's
    page edits them while it is off, and the public page draws nothing
    until it is on. */
Meteor.publish(HelpBriefingItems.publicationName, function () {
  return HelpBriefingItems.collection.find(
    { publicationStatus: 'published' },
    { fields: { updatedBy: 0 }, sort: { section: 1, order: 1 } },
  );
});
