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
import { EventSwipes } from '../../api/events/EventSwipes';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import EventPoster from '../components/EventPoster';
import { sortByDate } from '../utilities/helpers';

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
  const navigate = useNavigate();
  const userId = Meteor.userId();

  const { ready, events, goingIds } = useTracker(() => {
    const subscription = Meteor.subscribe(Events.userPublicationName);
    // Saving works from the poster here exactly as it does on Discover, so the
    // page needs to know what this person has already said yes to.
    const swipesSub = Meteor.subscribe(EventSwipes.userPublicationName);
    return {
      events: Events.collection.find({}, { sort: { date: 1 } }).fetch(),
      goingIds: new Set(EventSwipes.collection.find({ userId: Meteor.userId(), decision: 'interested' })
        .map(swipe => swipe.eventId)),
      ready: subscription.ready() && swipesSub.ready(),
    };
  }, []);

  const filteredEvents = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const matches = sortByDate(events).filter(event => query === '' || [event.title, event.description, event.location].some(value => (value || '').toLowerCase().includes(query)));
    if (sort === 'latest') {
      return [...matches].reverse();
    }
    if (sort === 'title') {
      return [...matches].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    return matches;
  }, [events, searchTerm, sort]);

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

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="list-events-page" className="page-shell py-4">
      <PageHead
        title="Events"
        action={<Link className="btn btn-soft-primary" to="/discover-events"><Stars /> Swipe</Link>}
      >
        Everything on the books, in one list.
      </PageHead>

      <div className="mb-toolbar">
        <input
          type="search"
          className="mb-field mb-field--search"
          placeholder="Search events…"
          aria-label="Search events"
          value={searchTerm}
          onChange={event => setSearchTerm(event.target.value)}
        />
        <span className="mb-toolbar-count">{filteredEvents.length} {filteredEvents.length === 1 ? 'event' : 'events'}</span>
        <select
          className="mb-field"
          aria-label="Sort events"
          value={sort}
          onChange={event => setSort(event.target.value)}
        >
          {SORTS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      </div>

      {filteredEvents.length === 0 ? (
        <div className="mb-empty">
          <CalendarX className="mb-empty-glyph" aria-hidden="true" />
          <h3>{searchTerm.trim() ? 'Nothing matches that.' : 'Nothing on the calendar yet.'}</h3>
          <p>
            {searchTerm.trim()
              ? 'Try a shorter word, or clear the search and browse the lot.'
              : 'Events land here the moment a club posts one.'}
          </p>
          {searchTerm.trim()
            ? <button type="button" className="btn btn-solid-primary" onClick={() => setSearchTerm('')}>Clear search</button>
            : <Link className="btn btn-solid-primary" to="/create-event">Start an event</Link>}
        </div>
      ) : (
        <div className="mb-grid mb-grid--posters">
          {filteredEvents.map((event, index) => (
            <motion.div key={event._id} variants={rise} initial="hidden" animate="show" custom={index}>
              <EventPoster
                event={event}
                going={goingIds.has(event._id)}
                onGoing={toggleGoing}
                onOpen={toggleGoing}
              />
            </motion.div>
          ))}
        </div>
      )}

      <section className="mt-5">
        <div className="mb-section-head">
          <h2>Month view</h2>
        </div>

        <Container id="event-calendar" className="calendar-container">
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
        </Container>
      </section>
    </Container>
  );
};

export default ListEvents;
