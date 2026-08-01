import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { useNavigate } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import PeopleBoxArt from '../components/brand/PeopleBoxArt';
import MatchEventCard from '../components/MatchEventCard';
import GroupCard from '../components/GroupCard';
import { scheduleLabel } from '../../api/club/schedule';
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
  const [when, setWhen] = useState('this-week');

  const { events, clubs } = useTracker(() => {
    Meteor.subscribe(Events.userPublicationName);
    Meteor.subscribe(Clubs.userPublicationName);
    return {
      events: Events.collection.find({}).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
    };
  }, []);

  const upcoming = useMemo(() => sortByDate(events.filter(event => new Date(event.date) >= new Date())).slice(0, 4), [events]);
  const groupsWithPlans = useMemo(() => clubs.filter(club => club.schedule).slice(0, 4), [clubs]);

  const search = submitEvent => {
    submitEvent.preventDefault();
    navigate(Meteor.userId() ? '/discover' : '/signin');
  };

  return (
    <main id="landing-page" className="landing-page">
      <section className="mb-hero">
        <div className="mb-shell">
          <div className="mb-hero-grid">
            <motion.div variants={rise} initial="hidden" animate="show" custom={0}>
              <h1>Find something worth showing up for.</h1>
              <p>Events, groups, and communities around you, matched to the things you actually care about.</p>

              <form className="mb-finder" onSubmit={search}>
                <div className="mb-finder-field">
                  <label htmlFor="mb-interest">What are you interested in?</label>
                  <input
                    id="mb-interest"
                    type="text"
                    placeholder="Live music, hiking, ceramics…"
                    value={interest}
                    onChange={changeEvent => setInterest(changeEvent.target.value)}
                  />
                </div>
                <div className="mb-finder-field">
                  <label htmlFor="mb-near">Near</label>
                  <input id="mb-near" type="text" defaultValue="Current location" />
                </div>
                <div className="mb-finder-field">
                  <label htmlFor="mb-when">When</label>
                  <select id="mb-when" value={when} onChange={changeEvent => setWhen(changeEvent.target.value)}>
                    <option value="tonight">Tonight</option>
                    <option value="this-week">This week</option>
                    <option value="this-weekend">This weekend</option>
                    <option value="anytime">Anytime</option>
                  </select>
                </div>
                <button type="submit" className="btn btn-match">Find it</button>
              </form>
            </motion.div>

            <motion.div className="mb-hero-art" variants={rise} initial="hidden" animate="show" custom={1}>
              <PeopleBoxArt />
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
            <div className="mb-grid">
              {upcoming.map((event, index) => {
                const place = placeFor(event._id);
                return (
                  <motion.div key={event._id} variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} custom={index}>
                    <MatchEventCard event={event} neighborhood={place.neighborhood} distance={place.distance} />
                  </motion.div>
                );
              })}
            </div>
          </section>
        )}

        {groupsWithPlans.length > 0 && (
          <section className="mb-section">
            <div className="mb-section-head">
              <h2>Groups with something coming up</h2>
              <a className="mb-section-link" href="/search-clubs">Browse groups</a>
            </div>
            <div className="mb-grid">
              {groupsWithPlans.map((club, index) => (
                <motion.div key={club._id} variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} custom={index}>
                  <GroupCard
                    club={club}
                    neighborhood={placeFor(club._id).neighborhood}
                    next={scheduleLabel(club.schedule)}
                  />
                </motion.div>
              ))}
            </div>
          </section>
        )}

        <section className="mb-section">
          <div className="mb-empty">
            <h3>Start something of your own.</h3>
            <p>Put it on the map and let people find it.</p>
            <a className="btn btn-solid-primary" href="/create-club">Start something</a>
          </div>
        </section>
      </div>
    </main>
  );
};

export default Landing;
