import { Meteor } from 'meteor/meteor';
import { EmergencyState, HelpResources } from '../../api/help/Help';

/** Public, both of them: the help page must work for somebody who has never
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
