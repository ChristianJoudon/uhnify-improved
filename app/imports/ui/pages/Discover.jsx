import React, { useMemo } from 'react';
import { Meteor } from 'meteor/meteor';
import { Link, useSearchParams } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import swal from 'sweetalert';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Profiles } from '../../api/profiles/Profiles';
import LoadingSpinner from '../components/LoadingSpinner';
import EventPoster from '../components/EventPoster';
import TopicPosters from '../components/TopicPosters';
import { normalizeCategories, sortByDate } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';
import { milesLabel, milesTo } from '../utilities/geo';
import { useOrigin } from '../utilities/useOrigin';
import { scoreClub } from '../utilities/recommend';

/**
 * A stable per-record jitter, so events with no host — and therefore no real
 * score — still hold a consistent order instead of reshuffling on every render.
 */
const seedValue = (id = '') => {
  let value = 0;
  for (let i = 0; i < id.length; i++) {
    value = (value * 31 + id.charCodeAt(i)) % 997;
  }
  return value;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** One row of filters, phrased as time rather than category. */
const WINDOWS = [
  { key: 'all', label: 'Anytime' },
  { key: 'today', label: 'Today' },
  { key: 'weekend', label: 'This weekend' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'month', label: 'This month' },
];

const endOfToday = () => {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end;
};

/**
 * The end of the coming Sunday — today, if today is Sunday. Date-component
 * stepping rather than millisecond arithmetic, so a DST boundary in between
 * cannot shift it.
 */
const endOfComingSunday = () => {
  const end = endOfToday();
  end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
  end.setHours(23, 59, 59, 999);
  return end;
};

/**
 * True when `date` falls in the chosen window. "This weekend" means the coming
 * Saturday and Sunday specifically, not simply the next seven days — otherwise
 * a Tuesday event answers a question nobody asked.
 */
const inWindow = (date, key) => {
  if (key === 'all') {
    return true;
  }
  if (key === 'today') {
    return date <= endOfToday();
  }
  if (key === 'week') {
    return date <= new Date(endOfToday().getTime() + 6 * DAY_MS);
  }
  if (key === 'month') {
    return date <= new Date(endOfToday().getTime() + 30 * DAY_MS);
  }
  // Weekend: the next Sat/Sun to arrive, so on a Sunday it still means today.
  // The ceiling is the coming Sunday, not today+7 — a rolling seven days
  // reaches into the FOLLOWING weekend whenever today is itself a Sat or Sun,
  // which is exactly when someone is most likely to ask for "this weekend".
  return (date.getDay() === 0 || date.getDay() === 6) && date <= endOfComingSunday();
};

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: index => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.34, delay: Math.min(index, 8) * 0.04, ease: [0.2, 0.8, 0.2, 1] },
  }),
};

const Discover = () => {
  const userId = Meteor.userId();
  // The homepage finder arrives here as ?q= and ?when=, so what someone typed
  // on the front page is what they land on.
  const [params, setParams] = useSearchParams();
  const { origin } = useOrigin();
  const query = (params.get('q') || '').trim();
  const requested = params.get('when');
  const topicKey = params.get('topic');
  const when = WINDOWS.some(option => option.key === requested) ? requested : 'all';

  const setWhen = key => {
    const updated = new URLSearchParams(params);
    if (key === 'all') {
      updated.delete('when');
    } else {
      updated.set('when', key);
    }
    setParams(updated, { replace: true });
  };

  const clearQuery = () => {
    const updated = new URLSearchParams(params);
    updated.delete('q');
    setParams(updated, { replace: true });
  };

  const setTopic = key => {
    const updated = new URLSearchParams(params);
    if (key) {
      updated.set('topic', key);
    } else {
      updated.delete('topic');
    }
    setParams(updated, { replace: true });
  };

  const { ready, events, clubs, swipes, interests, firstName } = useTracker(() => {
    const subs = [
      Meteor.subscribe(Events.userPublicationName),
      Meteor.subscribe(Clubs.userPublicationName),
      Meteor.subscribe(EventSwipes.userPublicationName),
      Meteor.subscribe(Profiles.userPublicationName),
    ];
    const profile = Profiles.collection.findOne({ userId });
    return {
      ready: subs.every(sub => sub.ready()),
      events: Events.collection.find({}).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      swipes: EventSwipes.collection.find({ userId }).fetch(),
      interests: normalizeCategories(profile?.interests),
      firstName: profile?.firstName || '',
    };
  }, [userId]);

  const goingIds = useMemo(
    () => new Set(swipes.filter(swipe => swipe.decision === 'interested').map(swipe => swipe.eventId)),
    [swipes],
  );
  const clubByNumber = useMemo(() => new Map(clubs.map(club => [club.clubID, club])), [clubs]);

  const upcoming = useMemo(
    () => sortByDate(events.filter(event => new Date(event.date) >= new Date())),
    [events],
  );

  /**
   * Best matches first, and the strongest few are drawn larger. The wall is one
   * ranked list rather than five competing shelves — the page's whole job is
   * "what is worth going to", so it should answer that once.
   */
  const wall = useMemo(() => {
    const context = { interests, friendClubIds: new Set() };

    const needle = query.toLowerCase();

    return upcoming
      .filter(event => inWindow(new Date(event.date), when))
      .filter(event => !needle || `${event.title} ${event.description || ''} ${event.location || ''}`
        .toLowerCase().includes(needle))
      .map(event => {
        const host = clubByNumber.get(event.eventID);
        const topic = topicFor(event.title, event.description, normalizeCategories(event.categories));
        return { event, host, topic, score: host ? scoreClub(host, context) : seedValue(event._id) / 997 };
      })
      .filter(item => !topicKey || item.topic.key === topicKey)
      .sort((a, b) => b.score - a.score);
  }, [upcoming, clubByNumber, interests, when, query, topicKey]);

  /**
   * Counted before the category filter is applied, so a cover can say how much
   * is behind it without the act of opening one emptying all the others.
   */
  const topicCounts = useMemo(() => {
    const tally = {};
    upcoming
      .filter(event => inWindow(new Date(event.date), when))
      .forEach(event => {
        const key = topicFor(event.title, event.description, normalizeCategories(event.categories)).key;
        tally[key] = (tally[key] || 0) + 1;
      });
    return tally;
  }, [upcoming, when]);

  const toggleGoing = event => {
    const isGoing = goingIds.has(event._id);
    const method = isGoing ? 'eventSwipes.remove' : 'eventSwipes.record';
    const args = isGoing ? [event._id] : [event._id, 'interested'];
    Meteor.call(method, ...args, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <main id="discover-page" className="mb-shell discover-page">
      <header className="discover-head">
        <h1>{firstName ? `What's on, ${firstName}.` : "What's on."}</h1>
        <p>Events near you, best matches first.</p>
        {query && (
          <button type="button" className="discover-query" onClick={clearQuery}>
            matching “{query}” <span aria-hidden="true">×</span>
            <span className="visually-hidden">Clear search</span>
          </button>
        )}
      </header>

      <div className="discover-bar">
        <div className="discover-windows" role="group" aria-label="When">
          {WINDOWS.map(option => (
            <button
              key={option.key}
              type="button"
              className={`discover-window${when === option.key ? ' is-on' : ''}`}
              onClick={() => setWhen(option.key)}
              aria-pressed={when === option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Link className="btn btn-match discover-swipe" to="/discover-events">Swipe instead</Link>
      </div>

      <TopicPosters selected={topicKey} onSelect={setTopic} counts={topicCounts} />

      {wall.length === 0 ? (
        <div className="mb-empty">
          <h3>{query ? `Nothing matching “${query}”.` : 'Nothing in that window.'}</h3>
          <p>Try a wider stretch of time, or start something yourself.</p>
          <Link className="btn btn-solid-primary" to="/create-event">Start an event</Link>
        </div>
      ) : (
        <div className="masonry discover-wall">
          {wall.map(({ event, host }, index) => {
            const miles = milesTo(event, origin);
            return (
              <motion.div
                key={event._id}
                className="masonry-item"
                variants={rise}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '-40px' }}
                custom={index}
              >
                <EventPoster
                  event={event}
                  host={host}
                  neighborhood={event.region}
                  distance={milesLabel(miles)}
                  going={goingIds.has(event._id)}
                  onGoing={toggleGoing}
                  onOpen={() => toggleGoing(event)}
                  // The top few are drawn large, so the wall has a focal point
                  // instead of reading as a uniform grid.
                  tier={index < 2 ? 'lg' : 'md'}
                />
              </motion.div>
            );
          })}
        </div>
      )}
    </main>
  );
};

export default Discover;
