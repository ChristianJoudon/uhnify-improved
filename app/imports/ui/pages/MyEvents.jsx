import React, { useMemo } from 'react';
import { Meteor } from 'meteor/meteor';
import { Alert, Button, Col, Container, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import swal from 'sweetalert';
import { Stars, XLg } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import EventCard from '../components/Events';
import { sortByDate } from '../utilities/helpers';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 180, damping: 22, delay: Math.min(index, 8) * 0.05 } }),
};

const MyEvents = () => {
  const { ready, events, clubs, memberships, links, swipes } = useTracker(() => {
    const eventsSub = Meteor.subscribe(Events.userPublicationName);
    const clubsSub = Meteor.subscribe(Clubs.userPublicationName);
    const membershipsSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    const linksSub = Meteor.subscribe(EventClubs.linksPublicationName);
    const swipesSub = Meteor.subscribe(EventSwipes.userPublicationName);
    return {
      ready: eventsSub.ready() && clubsSub.ready() && membershipsSub.ready() && linksSub.ready() && swipesSub.ready(),
      events: Events.collection.find({}).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      // Scoped to the signed-in user: friend-activity subscriptions share these collections.
      memberships: ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch(),
      links: EventClubs.collection.find({}).fetch(),
      swipes: EventSwipes.collection.find({ userId: Meteor.userId() }).fetch(),
    };
  }, []);

  const { clubEvents, savedEvents } = useMemo(() => {
    const joinedClubIds = new Set(memberships.map(membership => membership.clubId));
    const joinedClubNumbers = new Set(clubs.filter(club => joinedClubIds.has(club._id)).map(club => club.clubID));
    const linkedEventIds = new Set(links.filter(link => joinedClubIds.has(link.clubId)).map(link => link.eventId));
    const savedIds = new Set(swipes.filter(swipe => swipe.decision === 'interested').map(swipe => swipe.eventId));
    return {
      clubEvents: sortByDate(events.filter(event => linkedEventIds.has(event._id) || joinedClubNumbers.has(event.eventID))),
      savedEvents: sortByDate(events.filter(event => savedIds.has(event._id))),
    };
  }, [events, clubs, memberships, links, swipes]);

  const calendarEvents = useMemo(() => {
    const clubIds = new Set(clubEvents.map(event => event._id));
    return [
      ...clubEvents.map(event => ({
        title: event.title,
        start: new Date(event.date),
        description: event.description,
        classNames: ['calendar-event-pill'],
      })),
      ...savedEvents.filter(event => !clubIds.has(event._id)).map(event => ({
        title: event.title,
        start: new Date(event.date),
        description: event.description,
        classNames: ['calendar-event-pill', 'calendar-event-pill-saved'],
      })),
    ];
  }, [clubEvents, savedEvents]);

  const handleUnsave = eventId => {
    Meteor.call('eventSwipes.remove', eventId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="my-events" className="page-shell py-4">
      <div className="page-intro">
        <h1>My events</h1>
      </div>

      <div className="section-heading-row">
        <h2>Saved</h2>
        <Button as={Link} to="/discover-events" className="btn-soft-primary"><Stars /> Keep swiping</Button>
      </div>

      {savedEvents.length === 0 ? (
        <Alert className="empty-state-card text-center">
          <Stars size={36} />
          <h2>Nothing saved yet.</h2>
          <Button as={Link} to="/discover-events" className="btn-solid-primary">Start swiping</Button>
        </Alert>
      ) : (
        <Row xs={1} md={2} xl={4} className="g-4 mb-5">
          {savedEvents.map((event, index) => (
            <Col key={event._id}>
              <motion.div variants={rise} initial="hidden" animate="show" custom={index} className="h-100">
                <div className="saved-event-tile">
                  <EventCard event={event} />
                  <button
                    type="button"
                    className="saved-remove-btn"
                    onClick={() => handleUnsave(event._id)}
                    aria-label={`Remove ${event.title} from saved events`}
                    title="Remove from saved"
                  >
                    <XLg size={13} />
                  </button>
                </div>
              </motion.div>
            </Col>
          ))}
        </Row>
      )}

      <div className="section-heading-row mt-5">
        <h2>From your clubs</h2>
      </div>

      {clubEvents.length === 0 ? (
        <Alert className="empty-state-card text-center">
          <h2>No club events yet.</h2>
          <Button as={Link} to="/search-clubs" className="btn-solid-primary">Find clubs</Button>
        </Alert>
      ) : (
        <Row xs={1} md={2} xl={4} className="g-4">
          {clubEvents.map((event, index) => (
            <Col key={event._id}>
              <motion.div variants={rise} initial="hidden" animate="show" custom={index} className="h-100">
                <EventCard event={event} />
              </motion.div>
            </Col>
          ))}
        </Row>
      )}

      <Container id="event-calendar" className="calendar-container my-5">
        <FullCalendar
          plugins={[dayGridPlugin]}
          initialView="dayGridMonth"
          events={calendarEvents}
          headerToolbar={{
            start: 'today prev,next',
            center: 'title',
            end: 'dayGridMonth,dayGridWeek,dayGridDay',
          }}
        />
      </Container>
    </Container>
  );
};

export default MyEvents;
