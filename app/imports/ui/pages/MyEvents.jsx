import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import swal from 'sweetalert';
import { People, Stars } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import EventPoster from '../components/EventPoster';
import DetailsModal from '../components/DetailsModal';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { sortByDate } from '../utilities/helpers';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 180, damping: 22, delay: Math.min(index, 8) * 0.05 } }),
};

const MyEvents = () => {
  // The same sheet every other wall opens.
  const [detail, setDetail] = useState(null);

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

  const { clubEvents, goingEvents, goingIds } = useMemo(() => {
    const joinedClubIds = new Set(memberships.map(membership => membership.clubId));
    const joinedClubNumbers = new Set(clubs.filter(club => joinedClubIds.has(club._id)).map(club => club.clubID));
    const linkedEventIds = new Set(links.filter(link => joinedClubIds.has(link.clubId)).map(link => link.eventId));
    const going = new Set(swipes.filter(swipe => swipe.decision === 'going').map(swipe => swipe.eventId));
    return {
      clubEvents: sortByDate(events.filter(event => linkedEventIds.has(event._id) || joinedClubNumbers.has(event.eventID))),
      goingEvents: sortByDate(events.filter(event => going.has(event._id))),
      goingIds: going,
    };
  }, [events, clubs, memberships, links, swipes]);

  // The poster reads its host to colour itself when the event's own words are
  // too thin to place it; events carry the club's number, not its id.

  const calendarEvents = useMemo(() => {
    const clubIds = new Set(clubEvents.map(event => event._id));
    return [
      ...clubEvents.map(event => ({
        title: event.title,
        start: new Date(event.date),
        description: event.description,
        // Carried so a click opens this exact record rather than re-finding it
        // by title, which picks the wrong one whenever a series repeats a name.
        extendedProps: { record: event },
        classNames: ['calendar-event-pill'],
      })),
      ...goingEvents.filter(event => !clubIds.has(event._id)).map(event => ({
        title: event.title,
        start: new Date(event.date),
        description: event.description,
        extendedProps: { record: event },
        classNames: ['calendar-event-pill', 'calendar-event-pill-going'],
      })),
    ];
  }, [clubEvents, goingEvents]);

  // The poster's own footer button is how a person says they are going
  // everywhere else in the app, so taking it back from here is the same
  // gesture rather than a private remove control bolted onto the corner of
  // the card. It is sent as 'rsvp_canceled' — a changed mind — not as the
  // deck's 'undo', which it used to default to.
  const toggleGoing = event => {
    const going = goingIds.has(event._id);
    const args = going ? [event._id, 'rsvp_canceled'] : [event._id, 'going', 'event'];
    Meteor.call(going ? 'eventSwipes.remove' : 'eventSwipes.record', ...args, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  // `undoable` is for the Going wall alone: every card on it is one the person
  // chose, so its button says "Not going" instead of repeating "You're going"
  // down the page. A group's events are a mix, and keep the ordinary toggle.
  const posterWall = (list, undoable = false) => (
    <div className="mb-grid mb-grid--posters">
      {list.map((event, index) => (
        <motion.div key={event._id} variants={rise} initial="hidden" animate="show" custom={index}>
          <EventPoster
            event={event}
            going={goingIds.has(event._id)}
            undoable={undoable}
            onGoing={toggleGoing}
            onOpen={() => setDetail(event)}
          />
        </motion.div>
      ))}
    </div>
  );

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="my-events" className="page-shell py-4">
      <PageHead
        title="My events"
        action={<Link className="btn btn-soft-primary" to="/discover-events"><Stars /> Keep swiping</Link>}
      >
        Where you&apos;re going, and whatever your groups have planned.
      </PageHead>

      <section className="mb-5">
        <div className="mb-section-head">
          <h2>Going</h2>
          {goingEvents.length > 0 && (
            <span className="mb-toolbar-count">{goingEvents.length} {goingEvents.length === 1 ? 'event' : 'events'}</span>
          )}
        </div>

        {goingEvents.length === 0 ? (
          <div className="mb-empty">
            <Stars className="mb-empty-glyph" aria-hidden="true" />
            <h3>You&apos;re not going to anything yet.</h3>
            <p>Swipe through what is on. Whatever you say yes to lands here.</p>
            <Link className="btn btn-solid-primary" to="/discover-events">Start swiping</Link>
          </div>
        ) : posterWall(goingEvents, true)}
      </section>

      <section className="mb-5">
        <div className="mb-section-head">
          <h2>From your groups</h2>
          {/* The groups themselves live one page over. The nav keeps that page
              in the profile menu, so this is the link for a reader who came
              here looking for them. Count and link share the trailing edge;
              as separate children the row's space-between would strand the
              count in the middle. */}
          <span className="d-inline-flex align-items-baseline gap-3">
            {clubEvents.length > 0 && (
              <span className="mb-toolbar-count">{clubEvents.length} {clubEvents.length === 1 ? 'event' : 'events'}</span>
            )}
            <Link className="mb-section-link" to="/saved">Your groups</Link>
          </span>
        </div>

        {clubEvents.length === 0 ? (
          <div className="mb-empty">
            <People className="mb-empty-glyph" aria-hidden="true" />
            <h3>No group events yet.</h3>
            <p>Join a group and everything it puts on shows up here.</p>
            <Link className="btn btn-solid-primary" to="/search-clubs">Find groups</Link>
          </div>
        ) : posterWall(clubEvents)}
      </section>

      <section className="mb-5">
        <div className="mb-section-head">
          <h2>Month view</h2>
        </div>

        <div id="event-calendar" className="calendar-container">
          <FullCalendar
            plugins={[dayGridPlugin]}
            initialView="dayGridMonth"
            events={calendarEvents}
            height="auto"
            views={{ dayGridMonth: { dayMaxEvents: 3 } }}
            moreLinkText={count => `+${count} more`}
            eventClick={info => {
              info.jsEvent.preventDefault();
              setDetail(info.event.extendedProps.record);
            }}
            fixedWeekCount={false}
            dayHeaderFormat={{ weekday: 'short' }}
            eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'narrow' }}
            headerToolbar={{
              start: 'today prev,next',
              center: 'title',
              end: 'dayGridMonth,dayGridWeek,dayGridDay',
            }}
          />
        </div>
      </section>
      <DetailsModal
        show={Boolean(detail)}
        onHide={() => setDetail(null)}
        record={detail}
        kind="event"
        isIn={goingIds.has(detail?._id)}
        onAct={toggleGoing}
      />
    </Container>
  );
};

export default MyEvents;
