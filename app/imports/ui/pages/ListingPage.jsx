import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { useNavigate, useParams } from 'react-router-dom';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import DetailsModal from '../components/DetailsModal';
import LoadingSpinner from '../components/LoadingSpinner';
import NotFound from './NotFound';
import { joinGroupAndTell } from '../utilities/joinGroup';

/**
 * One listing at its own address — /e/<id> for an event, /g/<id> for a group
 * — which is what a local events app runs on: the link somebody texts a
 * friend. It opens the same sheet the walls open, over an empty page; closing
 * it goes to the calendar or Nearby. A listing the visitor may not see (private,
 * taken down, past) reads as not found, which is all a stranger should learn.
 */
const ListingPage = ({ kind }) => {
  const { _id } = useParams();
  const navigate = useNavigate();
  const isEvent = kind === 'event';
  const { record, ready, isIn } = useTracker(() => {
    const listing = Meteor.subscribe(isEvent ? Events.userPublicationName : Clubs.userPublicationName);
    const mine = Meteor.userId()
      ? [Meteor.subscribe(EventSwipes.userPublicationName), Meteor.subscribe(ProfileClubs.membershipPublicationName)]
      : [];
    const found = (isEvent ? Events.collection : Clubs.collection).findOne(_id);
    return {
      record: found,
      ready: listing.ready() && mine.every(sub => sub.ready()),
      isIn: isEvent
        ? Boolean(EventSwipes.collection.findOne({ userId: Meteor.userId(), eventId: _id, decision: 'going' }))
        : Boolean(ProfileClubs.collection.findOne({ userId: Meteor.userId(), clubId: _id })),
    };
  }, [_id, isEvent]);

  if (!ready) {
    return <LoadingSpinner />;
  }
  if (!record) {
    return <NotFound />;
  }
  const leave = () => navigate(isEvent ? '/upcoming-events' : '/search-clubs');
  const act = () => {
    if (!Meteor.userId()) {
      navigate('/signin');
      return;
    }
    if (isEvent) {
      Meteor.call(isIn ? 'eventSwipes.remove' : 'eventSwipes.record', ...(isIn ? [_id, 'rsvp_canceled'] : [_id, 'going', 'event']));
    } else if (isIn) {
      Meteor.call('profileClubs.remove', _id);
    } else {
      joinGroupAndTell(_id);
    }
  };
  return <DetailsModal show record={record} kind={kind} isIn={isIn} onAct={act} onHide={leave} />;
};

ListingPage.propTypes = {
  kind: PropTypes.oneOf(['event', 'club']).isRequired,
};

export default ListingPage;
