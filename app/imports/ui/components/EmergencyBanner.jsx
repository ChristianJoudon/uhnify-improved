import React from 'react';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Link, useLocation } from 'react-router-dom';
import { EmergencyState } from '../../api/help/Help';

/**
 * The one thing that goes above the nav on every page: when an administrator
 * has turned the emergency on, its headline and the way to the help page.
 * Not dismissable, on purpose — it is the point of the site that week.
 */
const EmergencyBanner = () => {
  const { pathname } = useLocation();
  const state = useTracker(() => {
    Meteor.subscribe(EmergencyState.publicationName);
    return EmergencyState.collection.findOne(EmergencyState.id);
  });
  if (!state?.active || pathname === '/help') {
    return null;
  }
  return (
    <div className="emergency-banner" role="region" aria-label="Emergency">
      <Link to="/help">
        <strong>{state.headline}</strong>
        <span> — water, food, shelters and the latest from the county →</span>
      </Link>
    </div>
  );
};

export default EmergencyBanner;
