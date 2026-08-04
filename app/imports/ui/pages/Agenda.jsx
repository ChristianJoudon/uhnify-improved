import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { useTracker } from 'meteor/react-meteor-data';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import DetailsModal from '../components/DetailsModal';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { clubOccurrences } from '../../api/club/schedule';

const FILTERS = [
  { key: 'all', label: 'Everything' },
  { key: 'events', label: 'Events' },
  { key: 'clubs', label: 'Group meetings' },
];

/** One calendar for everything: one-off events and recurring group meetings, filterable. */
const Agenda = () => {
  const [mode, setMode] = useState('all');
  /** The pill the reader clicked, so the month page can answer "what is this"
      without sending them to another page to find out. */
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
        extendedProps: { record: event, kind: 'event' },
        classNames: ['calendar-event-pill', savedIds.has(event._id) ? 'calendar-event-pill-saved' : ''].filter(Boolean),
      }));

    const meetings = clubs
      .filter(club => joinedClubIds.has(club._id))
      .flatMap(club => clubOccurrences(club, 26).map(start => ({
        title: club.name,
        start,
        // A recurring meeting has no record of its own — every occurrence is
        // the same group, so the sheet opens the group.
        extendedProps: { record: club, kind: 'club' },
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
      <PageHead title="Agenda">
        Everything you saved and every group you joined, on one month page.
      </PageHead>

      <div className="mb-toolbar">
        {/* These filter the one calendar below rather than swapping panels, so
            they are pressable chips, not tabs. */}
        <div className="mb-chip-row" role="group" aria-label="Filter the agenda">
          {FILTERS.map(filter => (
            <button
              key={filter.key}
              type="button"
              className="mb-chip"
              aria-pressed={mode === filter.key}
              onClick={() => setMode(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="agenda-legend">
          <span><i className="agenda-legend-dot--event" aria-hidden="true" /> Events</span>
          <span><i className="agenda-legend-dot--saved" aria-hidden="true" /> Saved</span>
          <span><i className="agenda-legend-dot--club" aria-hidden="true" /> Groups</span>
        </div>
      </div>

      <div className="calendar-container">
        <FullCalendar
          plugins={[dayGridPlugin]}
          initialView="dayGridMonth"
          events={calendarEvents}
          height="auto"
          // Cap entries per cell so a busy week stays a readable page, not a wall.
          views={{ dayGridMonth: { dayMaxEvents: 3 } }}
          moreLinkText={count => `+${count} more`}
          eventClick={info => {
            info.jsEvent.preventDefault();
            setDetail({ record: info.event.extendedProps.record, kind: info.event.extendedProps.kind });
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

      {/* Read-only on purpose: everything on this page is already saved or
          already joined, so there is no action left to offer — only the
          question of what the pill actually is. `onAct` is omitted and the
          sheet renders no button. */}
      <DetailsModal
        show={Boolean(detail)}
        onHide={() => setDetail(null)}
        record={detail?.record}
        kind={detail?.kind || 'event'}
        isIn
      />
    </Container>
  );
};

export default Agenda;
