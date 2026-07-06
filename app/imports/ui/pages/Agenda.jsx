import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { useTracker } from 'meteor/react-meteor-data';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import LoadingSpinner from '../components/LoadingSpinner';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { clubOccurrences } from '../../api/club/schedule';

/** One calendar for everything: one-off events and recurring club meetings, filterable. */
const Agenda = () => {
  const [mode, setMode] = useState('all');

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
      memberships: ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch(),
      links: EventClubs.collection.find({}).fetch(),
      swipes: EventSwipes.collection.find({ userId: Meteor.userId() }).fetch(),
    };
  }, []);

  const calendarEvents = useMemo(() => {
    const joinedClubIds = new Set(memberships.map(membership => membership.clubId));
    const joinedClubNumbers = new Set(clubs.filter(club => joinedClubIds.has(club._id)).map(club => club.clubID));
    const linkedEventIds = new Set(links.filter(link => joinedClubIds.has(link.clubId)).map(link => link.eventId));
    const savedIds = new Set(swipes.filter(swipe => swipe.decision === 'interested').map(swipe => swipe.eventId));

    const oneOff = events
      .filter(event => savedIds.has(event._id) || linkedEventIds.has(event._id) || joinedClubNumbers.has(event.eventID))
      .map(event => ({
        title: event.title,
        start: new Date(event.date),
        classNames: ['calendar-event-pill', savedIds.has(event._id) ? 'calendar-event-pill-saved' : ''].filter(Boolean),
      }));

    const meetings = clubs
      .filter(club => joinedClubIds.has(club._id))
      .flatMap(club => clubOccurrences(club, 26).map(start => ({
        title: club.name,
        start,
        classNames: ['calendar-event-pill', 'calendar-event-pill-club'],
      })));

    if (mode === 'events') {
      return oneOff;
    }
    if (mode === 'clubs') {
      return meetings;
    }
    return [...oneOff, ...meetings];
  }, [events, clubs, memberships, links, swipes, mode]);

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="agenda-page" className="page-shell py-4">
      <div className="page-intro">
        <h1>Agenda</h1>
      </div>

      <div className="agenda-toolbar">
        <div className="mode-toggle" role="tablist" aria-label="Agenda filter">
          <button type="button" className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>Everything</button>
          <button type="button" className={mode === 'events' ? 'active' : ''} onClick={() => setMode('events')}>Events</button>
          <button type="button" className={mode === 'clubs' ? 'active' : ''} onClick={() => setMode('clubs')}>Club meetings</button>
        </div>
        <div className="agenda-legend">
          <span><i style={{ background: 'var(--forest)' }} /> Events</span>
          <span><i style={{ background: 'var(--gold)' }} /> Saved</span>
          <span><i style={{ background: 'var(--sage)' }} /> Clubs</span>
        </div>
      </div>

      <Container className="calendar-container mb-5">
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

export default Agenda;
