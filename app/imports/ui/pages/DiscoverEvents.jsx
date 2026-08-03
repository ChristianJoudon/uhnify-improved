import React, { useEffect, useMemo, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Button, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import swal from 'sweetalert';
import {
  ArrowCounterclockwise,
  CalendarWeek,
  HeartFill,
  LightningChargeFill,
  People,
  PlusCircle,
  Stars,
  XLg,
} from 'react-bootstrap-icons';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import LoadingSpinner from '../components/LoadingSpinner';
import SwipeCard from '../components/SwipeCard';
import { sortByDate } from '../utilities/helpers';

// The row scrolls, so the timeline can run further ahead than a wrapping row
// could afford.
const TIME_WINDOWS = [
  { key: '3d', label: '3 days', days: 3 },
  { key: '1w', label: '1 week', days: 7 },
  { key: '2w', label: '2 weeks', days: 14 },
  { key: '1m', label: '1 month', days: 30 },
  { key: '3m', label: '3 months', days: 90 },
  { key: '6m', label: '6 months', days: 182 },
  { key: '1y', label: '1 year', days: 365 },
  { key: 'all', label: 'Anytime', days: null },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const STACK_SIZE = 4;

/** Tinder-style Discover deck: swipe right to save an event, left to pass, double-tap to flip. */
const DiscoverEvents = () => {
  const [mode, setMode] = useState('upcoming');
  const [windowKey, setWindowKey] = useState('all');
  // Cards mid-flight. Each entry snapshots the event doc so the ghost keeps rendering
  // (and finishes its animation) even after the swipe record removes it from the deck.
  const [exiting, setExiting] = useState([]);
  const [flippedId, setFlippedId] = useState(null);
  // Event ids swiped during this visit, in order — powers the undo/rewind button.
  const [history, setHistory] = useState([]);
  // Recently undone cards are pinned to the top of the deck (newest first) so a
  // rewind always visibly returns the card, even outside the current time window.
  const [pinnedIds, setPinnedIds] = useState([]);
  // Re-evaluate "today"/window boundaries every minute so a long-lived tab stays honest.
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setClockTick(tick => tick + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const { ready, events, swipes, clubs, memberships } = useTracker(() => {
    const eventsSub = Meteor.subscribe(Events.userPublicationName);
    const swipesSub = Meteor.subscribe(EventSwipes.userPublicationName);
    const clubsSub = Meteor.subscribe(Clubs.userPublicationName);
    const memberSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    return {
      ready: eventsSub.ready() && swipesSub.ready() && clubsSub.ready() && memberSub.ready(),
      events: Events.collection.find({}).fetch(),
      // Scoped to the signed-in user: other pages may subscribe friends' swipes into this collection.
      swipes: EventSwipes.collection.find({ userId: Meteor.userId() }).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      memberships: ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch(),
    };
  }, []);

  // The whole club, not just its name — the card needs its categories to fall
  // back on when an event's own title says nothing about the subject.
  const clubByNumber = useMemo(() => new Map(clubs.map(club => [club.clubID, club])), [clubs]);

  const swipedIds = useMemo(() => new Set(swipes.map(swipe => swipe.eventId)), [swipes]);
  const joinedClubIds = useMemo(
    () => new Set(memberships.map(membership => membership.clubId)),
    [memberships],
  );
  const savedCount = useMemo(() => swipes.filter(swipe => swipe.decision === 'interested').length, [swipes]);
  const passedCount = useMemo(() => swipes.filter(swipe => swipe.decision === 'passed').length, [swipes]);

  const windowDays = TIME_WINDOWS.find(timeWindow => timeWindow.key === windowKey)?.days;

  /**
   * In clubs mode the deck deals groups you have not joined and have not
   * already passed on. A group has no date, so the time windows do not apply —
   * the toolbar hides them.
   */
  const clubDeck = useMemo(() => {
    if (mode !== 'clubs') {
      return [];
    }
    return clubs
      .filter(club => !joinedClubIds.has(club._id) && !swipedIds.has(club._id))
      // The card asks for `title`; a group calls it `name`. Normalised here so
      // nothing downstream has to know which kind it is holding.
      .map(club => ({ ...club, title: club.name }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [mode, clubs, joinedClubIds, swipedIds]);

  const windowEvents = useMemo(() => {
    const now = new Date();
    const catchUpStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const horizon = windowDays ? new Date(now.getTime() + windowDays * DAY_MS) : null;
    return sortByDate(events.filter(event => {
      const date = event.date instanceof Date ? event.date : new Date(event.date);
      if (Number.isNaN(date.getTime())) {
        return false;
      }
      if (mode === 'today') {
        return date >= catchUpStart && date <= endOfToday;
      }
      return date >= now && (!horizon || date <= horizon);
    }));
  }, [events, mode, windowDays, clockTick]);

  // The deck: unswiped records in scope, with freshly undone cards pinned on top.
  const deck = useMemo(() => {
    const fresh = mode === 'clubs'
      ? clubDeck
      : windowEvents.filter(event => !swipedIds.has(event._id));
    const pool = mode === 'clubs' ? clubs : events;
    const pinned = pinnedIds
      .filter(id => !swipedIds.has(id))
      .map(id => pool.find(record => record._id === id))
      .filter(Boolean);
    if (pinned.length === 0) {
      return fresh;
    }
    const pinnedSet = new Set(pinned.map(event => event._id));
    return [...pinned, ...fresh.filter(event => !pinnedSet.has(event._id))];
  }, [mode, clubDeck, windowEvents, swipedIds, pinnedIds, events, clubs]);

  // Janitor: if a ghost's fly-off completion callback ever gets swallowed (animation
  // interrupted, tab backgrounded), sweep out ghosts whose swipe already left the deck.
  useEffect(() => {
    if (exiting.length === 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setExiting(prev => {
        const next = prev.filter(item => deck.some(event => event._id === item.event._id));
        return next.length === prev.length ? prev : next;
      });
    }, 2600);
    return () => clearTimeout(timer);
  }, [exiting, deck]);

  const exitingIds = useMemo(() => new Set(exiting.map(item => item.event._id)), [exiting]);
  const liveCards = useMemo(() => deck.filter(event => !exitingIds.has(event._id)).slice(0, STACK_SIZE), [deck, exitingIds]);
  const topEvent = liveCards[0];
  const topEventId = topEvent?._id;

  // A card flipped earlier (then buried by a filter change) should not still be
  // face-down when it resurfaces at the top of the deck later.
  useEffect(() => {
    setFlippedId(null);
  }, [topEventId]);

  // Ghosts render first (they sit above the stack); live cards fill the visible pile.
  // Both share keys by event id, so a card sliding from "live" to "ghost" keeps its
  // element — and therefore its in-progress drag position — across the transition.
  const renderedCards = useMemo(() => [
    ...exiting.map(item => ({ event: item.event, exitDirection: item.dir, stackIndex: 0 })),
    ...liveCards.map((event, index) => ({ event, exitDirection: null, stackIndex: index })),
  ], [exiting, liveCards]);

  const startSwipe = direction => {
    if (!topEvent || exitingIds.has(topEvent._id)) {
      return;
    }
    const swiped = topEvent;
    setExiting(prev => [...prev, { event: swiped, dir: direction }]);
    setHistory(prev => [...prev, swiped._id]);
    setFlippedId(null);
    // Recorded immediately — the client stub applies it synchronously, so even if this
    // card's fly-off is interrupted (filter change, unmount), the decision is never lost.
    const decision = direction === 'right' ? 'interested' : 'passed';
    if (mode === 'clubs' && decision === 'interested') {
      // Swiping right on a group is joining it — the deck is the join, not a
      // shortlist you have to work through again somewhere else.
      Meteor.call('profileClubs.add', swiped._id, joinError => {
        if (joinError) {
          swal('Error', joinError.reason || joinError.message, 'error');
        }
      });
    }
    Meteor.call('eventSwipes.record', swiped._id, decision, mode === 'clubs' ? 'club' : 'event', error => {
      if (error) {
        // Rollback: dropping the ghost lets the card spring back into the deck.
        setExiting(prev => prev.filter(item => item.event._id !== swiped._id));
        setHistory(prev => prev.filter(id => id !== swiped._id));
        swal('Swipe not saved', error.reason || error.message, 'error');
      }
    });
  };

  const handleExited = eventId => {
    setExiting(prev => prev.filter(item => item.event._id !== eventId));
  };

  const handleUndo = () => {
    if (history.length === 0 || exiting.length > 0) {
      return;
    }
    const lastId = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setPinnedIds(prev => [lastId, ...prev.filter(id => id !== lastId)]);
    setFlippedId(null);
    Meteor.call('eventSwipes.remove', lastId, error => {
      if (error) {
        // Put the undo back so the next Z press targets the same swipe again.
        setHistory(prev => [...prev, lastId]);
        setPinnedIds(prev => prev.filter(id => id !== lastId));
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  const handleResetPassed = () => {
    swal({
      title: 'Bring back passed events?',
      text: `The ${passedCount} events you passed on will return to the deck for another look.`,
      icon: 'info',
      buttons: ['Not now', 'Bring them back'],
    }).then(confirmed => {
      if (confirmed) {
        Meteor.call('eventSwipes.clearPassed', error => {
          if (error) {
            swal('Error', error.reason || error.message, 'error');
          }
        });
      }
    });
  };

  const toggleFlip = () => {
    if (topEvent) {
      setFlippedId(current => (current === topEvent._id ? null : topEvent._id));
    }
  };

  useEffect(() => {
    const onKeyDown = keyEvent => {
      if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) {
        return;
      }
      const target = keyEvent.target;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      if (document.querySelector('.swal-overlay--show-modal')) {
        return;
      }
      if (keyEvent.key === 'ArrowLeft') {
        keyEvent.preventDefault();
        startSwipe('left');
      } else if (keyEvent.key === 'ArrowRight') {
        keyEvent.preventDefault();
        startSwipe('right');
      } else if (keyEvent.key === 'ArrowUp' || (keyEvent.key === ' ' && tag !== 'BUTTON')) {
        // Space on a focused button keeps its native "click" behavior.
        keyEvent.preventDefault();
        toggleFlip();
      } else if (keyEvent.key === 'z' || keyEvent.key === 'Z' || keyEvent.key === 'Backspace') {
        keyEvent.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!ready) {
    return <LoadingSpinner />;
  }

  const liveCount = deck.filter(event => !exitingIds.has(event._id)).length;
  const windowLabel = mode === 'today'
    ? 'happening today'
    : `upcoming${windowDays ? ` in the next ${TIME_WINDOWS.find(timeWindow => timeWindow.key === windowKey).label}` : ''}`;

  return (
    <MotionConfig reducedMotion="user">
      <Container id="discover-events-page" className="page-shell py-3">
        <div className="discover-layout">
          <div className="discover-title">
            <h1><Stars /> Match</h1>
          </div>
          <div className="deck-toolbar">
            <div className="deck-toolbar-row">
              <div className="mode-toggle" role="tablist" aria-label="Event timing">
                <button
                  type="button"
                  className={mode === 'today' ? 'active' : ''}
                  onClick={() => setMode('today')}
                >
                  <LightningChargeFill /> Today
                </button>
                <button
                  type="button"
                  className={mode === 'upcoming' ? 'active' : ''}
                  onClick={() => setMode('upcoming')}
                >
                  <CalendarWeek /> Upcoming
                </button>
                <button
                  type="button"
                  className={mode === 'clubs' ? 'active' : ''}
                  onClick={() => setMode('clubs')}
                >
                  <People /> Groups
                </button>
              </div>
              <Link to="/user-events" className="deck-saved-link">
                <HeartFill size={13} /> {savedCount} saved
              </Link>
            </div>

            <AnimatePresence initial={false}>
              {mode === 'upcoming' && (
                <motion.div
                  className="window-chip-row"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  {/* One line that scrolls, so the timeline can run as far
                      ahead as we like without stealing height from the card. */}
                  <div className="window-chip-scroll">
                    {TIME_WINDOWS.map(timeWindow => (
                      <button
                        key={timeWindow.key}
                        type="button"
                        className={`window-chip${windowKey === timeWindow.key ? ' active' : ''}`}
                        aria-pressed={windowKey === timeWindow.key}
                        onClick={() => setWindowKey(timeWindow.key)}
                      >
                        {timeWindow.label}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="swipe-deck-area">
            <div className="swipe-deck">
              {liveCount === 0 && (
                (mode === 'clubs' ? clubs.length === 0 : windowEvents.length === 0) ? (
                  <motion.div
                    className="deck-empty-card"
                    initial={{ scale: 0.85, opacity: 0, y: 18 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                  >
                    <span className="mb-empty-glyph" role="img" aria-label="telescope">🔭</span>
                    <h2>{mode === 'clubs' ? 'No groups yet.' : `Nothing ${windowLabel}.`}</h2>
                    <p>Try a wider window.</p>
                    <div className="deck-empty-actions">
                      {mode === 'upcoming' && windowKey !== 'all' && (
                        <Button className="btn-soft-primary" onClick={() => setWindowKey('all')}>
                          <CalendarWeek /> Search anytime
                        </Button>
                      )}
                      {mode === 'today' && (
                        <Button className="btn-soft-primary" onClick={() => setMode('upcoming')}>
                          <CalendarWeek /> Look at upcoming
                        </Button>
                      )}
                      <Button as={Link} to="/create-event" className="btn-solid-primary">
                        <PlusCircle /> Start an event
                      </Button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    className="deck-empty-card"
                    initial={{ scale: 0.85, opacity: 0, y: 18 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                  >
                    <span className="mb-empty-glyph" role="img" aria-label="party popper">🎉</span>
                    <h2>{mode === 'clubs' ? "That's every group." : 'Deck cleared!'}</h2>
                    <p>That&apos;s everything {windowLabel}.</p>
                    <div className="deck-empty-actions">
                      {passedCount > 0 && (
                        <Button className="btn-soft-primary" onClick={handleResetPassed}>
                          <ArrowCounterclockwise /> Replay {passedCount} passed
                        </Button>
                      )}
                      <Button as={Link} to="/user-events" className="btn-solid-primary">
                        <HeartFill /> View saved events
                      </Button>
                    </div>
                  </motion.div>
                )
              )}
              {[...renderedCards].reverse().map(card => (
                <SwipeCard
                  key={card.event._id}
                  event={card.event}
                  hostName={clubByNumber.get(card.event.eventID)?.name || ''}
                  stackIndex={card.stackIndex}
                  exitDirection={card.exitDirection}
                  flipped={flippedId === card.event._id}
                  kind={mode === 'clubs' ? 'club' : 'event'}
                  onSwipe={startSwipe}
                  onFlip={toggleFlip}
                  onExited={handleExited}
                />
              ))}
            </div>

            <div className="swipe-actions">
              <motion.button
                type="button"
                className="swipe-btn swipe-btn-undo"
                whileHover={{ scale: 1.1, rotate: -20 }}
                whileTap={{ scale: 0.86 }}
                onClick={handleUndo}
                disabled={history.length === 0 || exiting.length > 0}
                aria-label="Undo last swipe"
                title="Undo last swipe (Z)"
              >
                <ArrowCounterclockwise />
              </motion.button>
              <motion.button
                type="button"
                className="swipe-btn swipe-btn-pass"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.86 }}
                onClick={() => startSwipe('left')}
                disabled={!topEvent}
                aria-label="Pass on this event"
                title="Pass (←)"
              >
                <XLg />
              </motion.button>
              <motion.button
                type="button"
                className="swipe-btn swipe-btn-save"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.86 }}
                onClick={() => startSwipe('right')}
                disabled={!topEvent}
                aria-label="Save this event"
                title="Interested (→)"
              >
                <HeartFill />
              </motion.button>
            </div>

            {/* Said once, under the deck. A gesture nobody is told about is a
                gesture nobody uses — which is what the old double-tap was. */}
            <p className="swipe-hint">
              {topEvent && flippedId === topEvent._id ? 'Tap the card to go back' : 'Tap the card for details'}
            </p>
          </div>
        </div>
      </Container>
    </MotionConfig>
  );
};

export default DiscoverEvents;
