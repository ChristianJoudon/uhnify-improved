import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Card, Col, Container, Row } from 'react-bootstrap';
import { CalendarEvent, PeopleFill, Stars } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import ClubItemAdmin from '../components/ClubItemAdmin';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import EventCardAdmin from '../components/EventsAdmin';
import LoadingSpinner from '../components/LoadingSpinner';
import ProfileCard from '../components/Profiles';

const StatCard = ({ icon, label, value }) => (
  <Card className="stat-card h-100">
    <Card.Body>
      <div className="stat-icon">{icon}</div>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </Card.Body>
  </Card>
);

StatCard.propTypes = {
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
      <div className="page-intro">
        <h1>Dashboard</h1>
      </div>

      <Row className="g-4 mb-5">
        <Col md={4}><StatCard icon={<Stars />} label="clubs" value={clubs.length} /></Col>
        <Col md={4}><StatCard icon={<CalendarEvent />} label="events" value={events.length} /></Col>
        <Col md={4}><StatCard icon={<PeopleFill />} label="profiles" value={profiles.length} /></Col>
      </Row>

      <section className="admin-section">
        <div className="section-heading-row">
          <h2>Clubs</h2>
        </div>
        <Row xs={1} md={2} xl={3} className="g-4">
          {clubs.map(club => <Col key={club._id}><ClubItemAdmin club={club} /></Col>)}
        </Row>
      </section>

      <section className="admin-section">
        <div className="section-heading-row">
          <h2>Events</h2>
        </div>
        <Row xs={1} md={2} xl={3} className="g-4">
          {events.map(event => <Col key={event._id}><EventCardAdmin event={event} /></Col>)}
        </Row>
      </section>

      <section className="admin-section">
        <div className="section-heading-row">
          <h2>Profiles</h2>
        </div>
        <Row xs={1} md={2} xl={4} className="g-4">
          {profiles.map(profile => <Col key={profile._id}><ProfileCard profile={profile} /></Col>)}
        </Row>
      </section>
    </Container>
  );
};

export default ListClubAdmin;
