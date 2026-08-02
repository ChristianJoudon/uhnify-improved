import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { useNavigate } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import EventPoster from '../components/EventPoster';
import { sortByDate } from '../utilities/helpers';

// Stand-in geography until real coordinates land — kept deterministic per item.
const NEIGHBORHOODS = ['Mānoa', 'Kaimukī', 'Chinatown', 'Kakaʻako', 'Waikīkī', 'Kalihi'];
const placeFor = (id = '') => {
  let value = 0;
  for (let i = 0; i < id.length; i++) {
    value = (value * 31 + id.charCodeAt(i)) % 997;
  }
  return {
    neighborhood: NEIGHBORHOODS[value % NEIGHBORHOODS.length],
    distance: `${(0.3 + (value % 45) / 10).toFixed(1)} mi`,
  };
};

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { duration: 0.34, delay: Math.min(index, 6) * 0.05, ease: [0.2, 0.8, 0.2, 1] } }),
};

const Landing = () => {
  const navigate = useNavigate();
  const [interest, setInterest] = useState('');
  const [when, setWhen] = useState('week');

  const { events, clubs } = useTracker(() => {
    Meteor.subscribe(Events.userPublicationName);
    Meteor.subscribe(Clubs.userPublicationName);
    return {
      events: Events.collection.find({}).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
    };
  }, []);

  // Three, deliberately. The homepage's job is to show what this is, then get
  // out of the way — a second and third grid of previews only delayed that.
  const upcoming = useMemo(
    () => sortByDate(events.filter(event => new Date(event.date) >= new Date())).slice(0, 3),
    [events],
  );
  const clubByNumber = useMemo(() => new Map(clubs.map(club => [club.clubID, club])), [clubs]);

  // The finder carries what was typed through to Discover. It used to discard
  // it and navigate to an unfiltered page, which made the control a prop.
  const search = submitEvent => {
    submitEvent.preventDefault();
    const query = new URLSearchParams();
    if (interest.trim()) {
      query.set('q', interest.trim());
    }
    if (when !== 'anytime') {
      query.set('when', when);
    }
    const suffix = query.toString() ? `?${query}` : '';
    navigate(Meteor.userId() ? `/discover${suffix}` : '/signin');
  };

  const enter = () => navigate(Meteor.userId() ? '/discover' : '/signin');

  return (
    <main id="landing-page" className="landing-page">
      <section className="mb-hero">
        <div className="mb-shell">
          <div className="mb-hero-grid">
            <motion.div variants={rise} initial="hidden" animate="show" custom={0}>
              <h1>Find something worth showing up for.</h1>
              <p>Events and groups around you, matched to the things you actually care about.</p>

              <form className="mb-finder" onSubmit={search}>
                <div className="mb-finder-field">
                  <label htmlFor="mb-interest">Interested in</label>
                  <input
                    id="mb-interest"
                    type="text"
                    placeholder="Live music, hiking, ceramics…"
                    value={interest}
                    onChange={changeEvent => setInterest(changeEvent.target.value)}
                  />
                </div>
                <div className="mb-finder-field">
                  <label htmlFor="mb-when">When</label>
                  <select id="mb-when" value={when} onChange={changeEvent => setWhen(changeEvent.target.value)}>
                    <option value="today">Tonight</option>
                    <option value="week">This week</option>
                    <option value="weekend">This weekend</option>
                    <option value="anytime">Anytime</option>
                  </select>
                </div>
                <button type="submit" className="btn btn-match">Find it</button>
              </form>
            </motion.div>

            <motion.div className="mb-hero-art" variants={rise} initial="hidden" animate="show" custom={1}>
              <img
                src="/images/hero-perfect-match.webp"
                alt="A matchbox of people, labelled Perfect Match"
                width="1254"
                height="1254"
                fetchpriority="high"
              />
            </motion.div>
          </div>
        </div>
      </section>

      <div className="mb-shell">
        {upcoming.length > 0 && (
          <section className="mb-section">
            <div className="mb-section-head">
              <h2>Happening nearby</h2>
              <a className="mb-section-link" href="/upcoming-events">See all</a>
            </div>
            <div className="landing-wall">
              {upcoming.map((event, index) => {
                const place = placeFor(event._id);
                return (
                  <motion.div
                    key={event._id}
                    variants={rise}
                    initial="hidden"
                    whileInView="show"
                    viewport={{ once: true, margin: '-60px' }}
                    custom={index}
                  >
                    <EventPoster
                      event={event}
                      host={clubByNumber.get(event.eventID)}
                      neighborhood={place.neighborhood}
                      distance={place.distance}
                      onGoing={enter}
                      onOpen={enter}
                    />
                  </motion.div>
                );
              })}
            </div>
          </section>
        )}

        <section className="mb-section">
          <p className="landing-outro">
            Running something of your own? <a href="/create-event">Put it on the map.</a>
          </p>
        </section>
      </div>
    </main>
  );
};

export default Landing;
