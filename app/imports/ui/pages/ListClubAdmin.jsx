import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Container } from 'react-bootstrap';
import { CalendarEvent, PeopleFill, Stars } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import ClubItemAdmin from '../components/ClubItemAdmin';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import EventCardAdmin from '../components/EventsAdmin';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import ProfileCard from '../components/Profiles';

/** The count reads first and the noun second — the number is the whole point. */
const Stat = ({ icon, label, value }) => (
  <div className="mb-panel admin-stat">
    <span className="admin-stat-glyph">{icon}</span>
    <strong className="admin-stat-value">{value}</strong>
    <span className="admin-stat-label">{label}</span>
  </div>
);

Stat.propTypes = {
  icon: PropTypes.node.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
};

const ListClubAdmin = () => {
  const { clubs, events, profiles, ready } = useTracker(() => {
    const clubSubscription = Meteor.subscribe(Clubs.adminPublicationName);
    const eventSubscription = Meteor.subscribe(Events.adminPublicationName);
    const profileSubscription = Meteor.subscribe(Profiles.adminPublicationName);
    return {
      clubs: Clubs.collection.find({}, { sort: { name: 1 } }).fetch(),
      events: Events.collection.find({}, { sort: { date: 1 } }).fetch(),
      profiles: Profiles.collection.find({}, { sort: { lastName: 1, firstName: 1 } }).fetch(),
      ready: clubSubscription.ready() && eventSubscription.ready() && profileSubscription.ready(),
    };
  }, []);

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="admin-dashboard" className="page-shell py-5">
      <PageHead title="Dashboard" eyebrow="Admin">
        Every group, event and person on MatchBook.
      </PageHead>

      <div className="admin-stats">
        <Stat icon={<Stars />} label="groups" value={clubs.length} />
        <Stat icon={<CalendarEvent />} label="events" value={events.length} />
        <Stat icon={<PeopleFill />} label="profiles" value={profiles.length} />
      </div>

      <section className="admin-section">
        <h2 className="admin-section-title">Groups</h2>
        {clubs.length === 0 ? (
          <div className="mb-empty">
            <h3>No groups yet.</h3>
            <p>Groups appear here as people start them.</p>
          </div>
        ) : (
          <div className="mb-grid">
            {clubs.map(club => <ClubItemAdmin key={club._id} club={club} />)}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2 className="admin-section-title">Events</h2>
        {events.length === 0 ? (
          <div className="mb-empty">
            <h3>No events yet.</h3>
            <p>Every event anyone posts shows up here, past ones included.</p>
          </div>
        ) : (
          <div className="mb-grid">
            {events.map(event => <EventCardAdmin key={event._id} event={event} />)}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2 className="admin-section-title">People</h2>
        {profiles.length === 0 ? (
          <div className="mb-empty">
            <h3>No profiles yet.</h3>
            <p>Everyone who signs up gets one.</p>
          </div>
        ) : (
          <div className="mb-grid">
            {profiles.map(profile => <ProfileCard key={profile._id} profile={profile} />)}
          </div>
        )}
      </section>
    </Container>
  );
};

export default ListClubAdmin;
