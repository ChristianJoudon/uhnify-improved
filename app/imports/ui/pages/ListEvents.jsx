import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Alert, Button, Col, Container, Form, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import { Search, Stars } from 'react-bootstrap-icons';
import { Events } from '../../api/events/Events';
import EventCard from '../components/Events';
import LoadingSpinner from '../components/LoadingSpinner';
import { sortByDate } from '../utilities/helpers';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 180, damping: 22, delay: Math.min(index, 8) * 0.05 } }),
};

const ListEvents = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const { ready, events } = useTracker(() => {
    const subscription = Meteor.subscribe(Events.userPublicationName);
    return {
      events: Events.collection.find({}, { sort: { date: 1 } }).fetch(),
      ready: subscription.ready(),
    };
  }, []);

  const filteredEvents = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return sortByDate(events).filter(event => query === '' || [event.title, event.description, event.location].some(value => (value || '').toLowerCase().includes(query)));
  }, [events, searchTerm]);

  const formattedEvents = filteredEvents.map(event => ({
    title: event.title,
    start: new Date(event.date),
    description: event.description,
    classNames: ['calendar-event-pill'],
  }));

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="list-events-page" className="page-shell py-4">
      <div className="page-intro">
        <h1>Events</h1>
      </div>

      <div className="toolbar-card mb-4">
        <div className="search-box">
          <Search />
          <Form.Control
            type="text"
            placeholder="Search events…"
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
            className="search-input"
          />
        </div>
        <Button as={Link} to="/discover-events" className="btn-soft-primary"><Stars /> Swipe</Button>
      </div>

      {filteredEvents.length === 0 ? (
        <Alert className="empty-state-card">
          <h2>No matches.</h2>
        </Alert>
      ) : (
        <Row xs={1} md={2} xl={4} className="g-4">
          {filteredEvents.map((event, index) => (
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
          events={formattedEvents}
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

export default ListEvents;
