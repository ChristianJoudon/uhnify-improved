import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import swal from 'sweetalert';
import { CalendarX, Stars } from 'react-bootstrap-icons';
import { Events } from '../../api/events/Events';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import EventPoster from '../components/EventPoster';
import TopicPosters from '../components/TopicPosters';
import KindToggle from '../components/KindToggle';
import Club from '../components/Club';
import DetailsModal from '../components/DetailsModal';
import { normalizeCategories, sortByDate } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';

const SORTS = [
  { key: 'soonest', label: 'Earliest first' },
  { key: 'latest', label: 'Latest first' },
  { key: 'title', label: 'A–Z' },
];

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 180, damping: 22, delay: Math.min(index, 8) * 0.05 } }),
};

const ListEvents = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sort, setSort] = useState('soonest');
  // Same two controls as Nearby, in the same order, because it is the same
  // question asked of a different frame: there the frame is a map, here a month.
  const [kind, setKind] = useState('events');
  const [topicKey, setTopicKey] = useState(null);
  // The same sheet Nearby and Discover open, so a card behaves the same way
  // whichever page the reader met it on.
  const [detail, setDetail] = useState(null);
  const navigate = useNavigate();
  const userId = Meteor.userId();

  const { ready, events, clubs, goingIds, joinedIds } = useTracker(() => {
    const subscription = Meteor.subscribe(Events.userPublicationName);
    // Saving works from the poster here exactly as it does on Discover, so the
    // page needs to know what this person has already said yes to.
    const swipesSub = Meteor.subscribe(EventSwipes.userPublicationName);
    const clubsSub = Meteor.subscribe(Clubs.userPublicationName);
    const memberSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    return {
      events: Events.collection.find({}, { sort: { date: 1 } }).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      goingIds: new Set(EventSwipes.collection.find({ userId: Meteor.userId(), decision: 'interested' })
        .map(swipe => swipe.eventId)),
      joinedIds: new Set(ProfileClubs.collection.find({ userId: Meteor.userId() })
        .map(membership => membership.clubId)),
      ready: subscription.ready() && swipesSub.ready() && clubsSub.ready() && memberSub.ready(),
    };
  }, []);

  const filteredEvents = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const matches = sortByDate(events)
      .filter(event => !topicKey
        || topicFor(event.title, event.description, normalizeCategories(event.categories)).key === topicKey)
      .filter(event => query === '' || [event.title, event.description, event.location].some(value => (value || '').toLowerCase().includes(query)));
    if (sort === 'latest') {
      return [...matches].reverse();
    }
    if (sort === 'title') {
      return [...matches].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    return matches;
  }, [events, searchTerm, sort, topicKey]);

  const filteredClubs = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return clubs
      .filter(club => !topicKey
        || topicFor(normalizeCategories(club.categories), club.tags, club.name, club.description).key === topicKey)
      .filter(club => query === '' || [club.name, club.description, club.location]
        .some(value => (value || '').toLowerCase().includes(query)));
  }, [clubs, searchTerm, topicKey]);

  /** Counts on the covers follow whichever kind is showing. */
  const topicCounts = useMemo(() => {
    const tally = {};
    const source = kind === 'clubs'
      ? clubs.map(club => topicFor(normalizeCategories(club.categories), club.tags, club.name, club.description).key)
      : events.map(event => topicFor(event.title, event.description, normalizeCategories(event.categories)).key);
    source.forEach(key => { tally[key] = (tally[key] || 0) + 1; });
    return tally;
  }, [kind, events, clubs]);

  // The empty state and the grid read one list, so they can never disagree about
  // whether there is anything here. They did: the gate counted events while the
  // grid drew groups, so searching "lions" in Groups mode printed "Nothing
  // matches that" above three groups it then refused to draw.
  const showing = kind === 'clubs' ? filteredClubs : filteredEvents;

  const formattedEvents = filteredEvents.map(event => ({
    title: event.title,
    start: new Date(event.date),
    description: event.description,
    classNames: ['calendar-event-pill'],
  }));

  // This route is public, so the first thing an unsigned visitor asks of an
  // event is also the thing that needs an account.
  const toggleGoing = event => {
    if (!userId) {
      navigate('/signin');
      return;
    }
    const going = goingIds.has(event._id);
    const args = going ? [event._id] : [event._id, 'interested'];
    Meteor.call(going ? 'eventSwipes.remove' : 'eventSwipes.record', ...args, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  const joinClub = clubId => {
    if (!userId) {
      navigate('/signin');
      return;
    }
    Meteor.call('profileClubs.add', clubId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="list-events-page" className="page-shell py-4">
      <PageHead
        title="Calendar"
        action={<Link className="btn btn-soft-primary" to="/discover-events"><Stars /> Swipe</Link>}
      >
        Everything on the books, by the month.
      </PageHead>

      {/* The month is this page's frame, the way the map is Nearby's: what the
          calendar shows and what the cards below show are always one set. */}

      <KindToggle
        value={kind}
        onChange={setKind}
        counts={{ events: filteredEvents.length, clubs: filteredClubs.length }}
      />

      <TopicPosters selected={topicKey} onSelect={setTopicKey} counts={topicCounts} compact />

      <div id="event-calendar" className="calendar-container">
        <FullCalendar
          plugins={[dayGridPlugin]}
          initialView="dayGridMonth"
          events={formattedEvents}
          height="auto"
          views={{ dayGridMonth: { dayMaxEvents: 3 } }}
          moreLinkText={count => `+${count} more`}
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

      <div className="mb-toolbar">
        <input
          type="search"
          className="mb-field mb-field--search"
          placeholder={kind === 'clubs' ? 'Search groups…' : 'Search events…'}
          aria-label={kind === 'clubs' ? 'Search groups' : 'Search events'}
          value={searchTerm}
          onChange={event => setSearchTerm(event.target.value)}
        />
        <span className="mb-toolbar-count">
          {kind === 'clubs'
            ? `${filteredClubs.length} ${filteredClubs.length === 1 ? 'group' : 'groups'}`
            : `${filteredEvents.length} ${filteredEvents.length === 1 ? 'event' : 'events'}`}
        </span>
        {/* Only the events list reads `sort`; offering it over groups would be a
            control that visibly does nothing. */}
        {kind === 'events' && (
          <select
            className="mb-field"
            aria-label="Sort events"
            value={sort}
            onChange={event => setSort(event.target.value)}
          >
            {SORTS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        )}
      </div>

      {showing.length === 0 ? (
        <div className="mb-empty">
          <CalendarX className="mb-empty-glyph" aria-hidden="true" />
          <h3>
            {searchTerm.trim()
              ? 'Nothing matches that.'
              : `Nothing ${kind === 'clubs' ? 'here yet.' : 'on the calendar yet.'}`}
          </h3>
          <p>
            {searchTerm.trim()
              ? 'Try a shorter word, or clear the search and browse the lot.'
              : `${kind === 'clubs' ? 'Groups' : 'Events'} land here as people start them.`}
          </p>
          {searchTerm.trim()
            ? <button type="button" className="btn btn-solid-primary" onClick={() => setSearchTerm('')}>Clear search</button>
            : (
              <Link className="btn btn-solid-primary" to={kind === 'clubs' ? '/create-club' : '/create-event'}>
                {kind === 'clubs' ? 'Start a group' : 'Start an event'}
              </Link>
            )}
        </div>
      ) : (
        <div className="mb-grid mb-grid--posters">
          {kind === 'clubs'
            ? filteredClubs.map((club, index) => (
              <motion.div key={club._id} variants={rise} initial="hidden" animate="show" custom={index}>
                <Club
                  club={club}
                  tier="md"
                  isMember={joinedIds.has(club._id)}
                  onAddToProfile={joinClub}
                  onViewDetails={() => setDetail({ record: club, kind: 'club' })}
                />
              </motion.div>
            ))
            : filteredEvents.map((event, index) => (
              <motion.div key={event._id} variants={rise} initial="hidden" animate="show" custom={index}>
                <EventPoster
                  event={event}
                  going={goingIds.has(event._id)}
                  onGoing={toggleGoing}
                  onOpen={() => setDetail({ record: event, kind: 'event' })}
                />
              </motion.div>
            ))}
        </div>
      )}

      <DetailsModal
        show={Boolean(detail)}
        onHide={() => setDetail(null)}
        record={detail?.record}
        kind={detail?.kind || 'event'}
        isIn={detail?.kind === 'club'
          ? joinedIds.has(detail?.record?._id)
          : goingIds.has(detail?.record?._id)}
        onAct={detail?.kind === 'club' ? record => joinClub(record._id) : toggleGoing}
      />
    </Container>
  );
};

export default ListEvents;
