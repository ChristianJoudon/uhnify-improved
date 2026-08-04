import React, { useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Link, useNavigate } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import { Events } from '../../api/events/Events';
import EventPoster from '../components/EventPoster';
import { sortByDate } from '../utilities/helpers';
import { KAUAI, milesLabel, milesTo } from '../utilities/geo';
import Segmented from '../components/form/Segmented';
import { useTuck } from '../utilities/useTuck';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { duration: 0.34, delay: Math.min(index, 6) * 0.05, ease: [0.2, 0.8, 0.2, 1] } }),
};

const Landing = () => {
  // The choices slide under "Find it" rather than over it — see .mb-tuck.
  const whenTuck = useTuck();
  const navigate = useNavigate();
  const [interest, setInterest] = useState('');
  const [when, setWhen] = useState('week');

  const { events } = useTracker(() => {
    Meteor.subscribe(Events.userPublicationName);
    return { events: Events.collection.find({}).fetch() };
  }, []);

  /**
   * What you could actually go and do.
   *
   * Not simply the next three on the calendar: something a fortnight away on
   * the far side of the island is "upcoming" but it is not an answer to "what
   * is on right now". So this ranks on both axes at once — hours from now and
   * miles from here — and takes the best three. A thing tonight ten minutes
   * away beats a thing tonight forty minutes away, and both beat next week.
   */
  const upcoming = useMemo(() => {
    const now = Date.now();
    const HOURS = 36;
    return sortByDate(events.filter(event => new Date(event.date) >= new Date()))
      .map(event => {
        const hours = (new Date(event.date).getTime() - now) / 3600000;
        const miles = milesTo(event, KAUAI);
        // Both normalised to 0–1 and added, so neither can dominate: soon but
        // far and close but distant-in-time score alike, which is honest.
        const soon = Math.min(hours / HOURS, 1);
        const near = Math.min((miles === null ? 25 : miles) / 25, 1);
        return { event, immediacy: soon + near };
      })
      .sort((a, b) => a.immediacy - b.immediacy)
      .slice(0, 3)
      .map(item => item.event);
  }, [events]);

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

  // A raw <a href> to /create-event full-reloaded the page, and ProtectedRoute
  // reads Meteor.userId() once at first render — before the login token has
  // resumed — so it bounced signed-in authors to the sign-in form too. Reading
  // it at click time inside the live client never has that problem.
  const organize = () => navigate(Meteor.userId() ? '/create-event' : '/signin');

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
                <div className="mb-finder-field is-choice">
                  {/* The first control a stranger meets. It was the one thing on
                      the homepage the browser drew rather than the app.

                      The scroller around it is what keeps the choices off the
                      submit button: too narrow to hold all four, they tuck
                      beneath it and scroll back out, instead of overlapping it
                      for as long as a resize is in flight. */}
                  <div ref={whenTuck.ref} className={whenTuck.className}>
                    <Segmented
                      name="mb-when"
                      label="When"
                      size="sm"
                      value={when}
                      options={[
                        { value: 'today', label: 'Tonight' },
                        { value: 'week', label: 'This week' },
                        { value: 'weekend', label: 'Weekend' },
                        { value: 'anytime', label: 'Anytime' },
                      ]}
                      onChange={setWhen}
                    />
                  </div>
                </div>
                <button type="submit" className="btn btn-match">Find it</button>
              </form>
            </motion.div>

            <motion.div className="mb-hero-art" variants={rise} initial="hidden" animate="show" custom={1}>
              <img
                src="/images/hero-matchbook.webp"
                alt="An open matchbook with a few matches beside it"
                width="1400"
                height="891"
              />
            </motion.div>
          </div>
        </div>
      </section>

      <div className="mb-shell">
        {upcoming.length > 0 && (
          <section className="mb-section">
            <div className="mb-section-head">
              <h2>Happening right now, nearby</h2>
              <Link className="mb-section-link" to="/upcoming-events">See all</Link>
            </div>
            <div className="landing-wall">
              {upcoming.map((event, index) => {
                // The public page has no permission to ask for a position, so
                // it measures from the island rather than from the reader.
                const miles = milesTo(event, KAUAI);
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
                      distance={milesLabel(miles)}
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
            Running something of your own?{' '}
            <button type="button" className="mb-inline-link" onClick={organize}>Put it on the map.</button>
          </p>
        </section>
      </div>
    </main>
  );
};

export default Landing;
