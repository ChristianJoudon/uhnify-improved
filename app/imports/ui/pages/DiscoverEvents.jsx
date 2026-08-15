import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Button, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import swal from 'sweetalert';
import {
  ArrowCounterclockwise,
  ArrowRepeat,
  CalendarWeek,
  HeartFill,
  LightningChargeFill,
  People,
  PlusCircle,
  XLg,
} from 'react-bootstrap-icons';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import LoadingSpinner from '../components/LoadingSpinner';
// Explicit extension keeps Meteor from ever resolving a same-name style asset
// as the component module during a hot reload.
import SwipeCard from '../components/SwipeCard.jsx';
import { sortByDate } from '../utilities/helpers';
import { collapseEventListings } from '../utilities/eventSeries';
import { useTuck } from '../utilities/useTuck';

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

/** Tinder-style Discover deck: swipe right to save an event, left to pass, tap to flip. */
const DiscoverEvents = () => {
  const deckTuck = useTuck();
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
  // Server-ranked results are an ordering overlay on the already-published
  // records. If the call is unavailable, every calculation below naturally
  // falls back to the deck's existing date/name order.
  const [recommendationRuns, setRecommendationRuns] = useState({ event: null, group: null });
  const impressionKeys = useRef(new Set());
  const refocusCardAfterSwipe = useRef(false);

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

  const recommendationKind = mode === 'clubs' ? 'group' : 'event';

  useEffect(() => {
    if (!Meteor.userId()) {
      return undefined;
    }
    let active = true;
    Meteor.call('recommendations.get', {
      kind: recommendationKind,
      surface: 'swipe_deck',
      limit: 100,
    }, (error, result) => {
      if (!active) {
        return;
      }
      setRecommendationRuns(current => ({
        ...current,
        [recommendationKind]: error || !result ? null : result,
      }));
    });
    return () => {
      active = false;
    };
  }, [recommendationKind, swipes.length, memberships.length]);

  const recommendationRun = recommendationRuns[recommendationKind];
  const recommendationById = useMemo(
    () => new Map((recommendationRun?.items || []).map(item => [item._id, item])),
    [recommendationRun],
  );

  const recommendationMetadata = record => {
    const item = recommendationById.get(record?._id);
    if (!item || !recommendationRun?.requestId) {
      return null;
    }
    return {
      requestId: recommendationRun.requestId,
      position: item.position,
      displaySize: item.displayPriority || 'standard',
      modelVersion: recommendationRun.modelVersion,
      selectedTier: item.selectedTier || recommendationRun.selectedTier,
      componentsUsed: item.componentsUsed || recommendationRun.capabilitySnapshot?.availableComponents,
    };
  };

  const compareByRecommendation = (left, right) => {
    const leftPosition = recommendationById.get(left?._id)?.position;
    const rightPosition = recommendationById.get(right?._id)?.position;
    if (Number.isInteger(leftPosition) && Number.isInteger(rightPosition)) {
      return leftPosition - rightPosition;
    }
    if (Number.isInteger(leftPosition)) {
      return -1;
    }
    if (Number.isInteger(rightPosition)) {
      return 1;
    }
    return 0;
  };

  const withRecommendation = record => {
    const metadata = recommendationMetadata(record);
    return metadata ? { ...record, _recommendation: metadata } : record;
  };

  // The whole club, not just its name — the card needs its categories to fall
  // back on when an event's own title says nothing about the subject.
  const clubByNumber = useMemo(() => new Map(clubs.map(club => [club.clubID, club])), [clubs]);

  const swipedIds = useMemo(() => new Set(swipes.map(swipe => swipe.eventId)), [swipes]);
  const joinedClubIds = useMemo(
    () => new Set(memberships.map(membership => membership.clubId)),
    [memberships],
  );
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
      .sort((a, b) => compareByRecommendation(a, b) || a.title.localeCompare(b.title))
      .map(withRecommendation);
  }, [mode, clubs, joinedClubIds, swipedIds, recommendationById, recommendationRun]);

  const windowEvents = useMemo(() => {
    const now = new Date();
    const catchUpStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const horizon = windowDays ? new Date(now.getTime() + windowDays * DAY_MS) : null;
    const inWindowEvents = sortByDate(events.filter(event => {
      const date = event.date instanceof Date ? event.date : new Date(event.date);
      if (Number.isNaN(date.getTime())) {
        return false;
      }
      if (mode === 'today') {
        return date >= catchUpStart && date <= endOfToday;
      }
      return date >= now && (!horizon || date <= horizon);
    }));
    return collapseEventListings(inWindowEvents)
      .sort(compareByRecommendation)
      .map(withRecommendation);
  }, [events, mode, windowDays, clockTick, recommendationById, recommendationRun]);

  // The deck: unswiped records in scope, with freshly undone cards pinned on top.
  const deck = useMemo(() => {
    const fresh = mode === 'clubs'
      ? clubDeck
      : windowEvents.filter(event => !swipedIds.has(event._id));
    const pool = (mode === 'clubs' ? clubs : events).map(withRecommendation);
    const pinned = pinnedIds
      .filter(id => !swipedIds.has(id))
      .map(id => pool.find(record => record._id === id))
      .filter(Boolean);
    if (pinned.length === 0) {
      return fresh;
    }
    const pinnedSet = new Set(pinned.map(event => event._id));
    return [...pinned, ...fresh.filter(event => !pinnedSet.has(event._id))];
  }, [mode, clubDeck, windowEvents, swipedIds, pinnedIds, events, clubs, recommendationById, recommendationRun]);

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

  useEffect(() => {
    const recommendation = topEvent?._recommendation;
    if (!topEventId || !recommendation?.requestId || !Number.isInteger(recommendation.position)) {
      return;
    }
    const entityType = mode === 'clubs' ? 'group' : 'event';
    const clientEventId = `impression:${recommendation.requestId}:${entityType}:${topEventId}:${recommendation.position}`;
    if (impressionKeys.current.has(clientEventId)) {
      return;
    }
    impressionKeys.current.add(clientEventId);
    Meteor.call('recommendationInteractions.record', {
      entityType,
      entityId: topEventId,
      action: 'impression',
      clientEventId,
      requestId: recommendation.requestId,
      position: recommendation.position,
      displaySize: recommendation.displaySize,
    });
  }, [topEventId, topEvent?._recommendation?.requestId, mode]);

  // A card flipped earlier (then buried by a filter change) should not still be
  // face-down when it resurfaces at the top of the deck later.
  useEffect(() => {
    setFlippedId(null);
  }, [topEventId]);

  // When a keyboard user swipes from the focused card, keep them in the deck
  // by moving focus to the newly exposed top card. Pointer and action-button
  // decisions retain their existing focus naturally.
  useEffect(() => {
    if (!refocusCardAfterSwipe.current) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const nextCard = document.querySelector('.match-swipe-card.is-top');
      if (nextCard) {
        nextCard.focus({ preventScroll: true });
      }
      refocusCardAfterSwipe.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
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
    refocusCardAfterSwipe.current = Boolean(document.activeElement?.closest?.('.match-swipe-card.is-top'));
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
      const joinContext = swiped._recommendation
        ? { ...swiped._recommendation, clientEventId: `join:${Random.id()}` }
        : {};
      Meteor.call('profileClubs.add', swiped._id, joinContext, joinError => {
        if (joinError) {
          swal('Error', joinError.reason || joinError.message, 'error');
        }
      });
    }
    const recommendationContext = swiped._recommendation
      ? { ...swiped._recommendation, clientEventId: `swipe:${Random.id()}` }
      : {};
    Meteor.call('eventSwipes.record', swiped._id, decision, mode === 'clubs' ? 'club' : 'event', recommendationContext, error => {
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
      if (flippedId !== topEvent._id && topEvent._recommendation?.requestId) {
        Meteor.call('recommendationInteractions.record', {
          entityType: mode === 'clubs' ? 'group' : 'event',
          entityId: topEvent._id,
          action: 'flipped',
          clientEventId: `flip:${Random.id()}`,
          requestId: topEvent._recommendation.requestId,
          position: topEvent._recommendation.position,
          displaySize: topEvent._recommendation.displaySize,
        });
      }
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
      // Let focused links and controls own their native arrow, Space and
      // Backspace behavior. The focused top card is the one intentional
      // exception: it supports the documented deck shortcuts.
      const topCard = target?.closest?.('.match-swipe-card.is-top');
      const interactiveControl = target?.closest?.('button, a, [role="button"]');
      if (interactiveControl && !topCard) {
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
      } else if (keyEvent.key === 'ArrowUp' || keyEvent.key === ' ') {
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
          {/* No page title. The nav already says Match, the deck says what it
              is by being a deck, and on a laptop the heading was costing the
              card the vertical room that makes it feel like a card. */}
          <div className="deck-toolbar">
            <div ref={deckTuck.ref} className={`deck-toolbar-row ${deckTuck.className}`}>
              {/* role="group", not tablist: there are no tabpanels, and a tablist
                  without tabs makes a screen reader announce positions that do
                  not exist. The chips report their own state instead. */}
              <div className="mode-toggle" role="group" aria-label="What to show">
                <button
                  type="button"
                  className={mode === 'today' ? 'active' : ''}
                  aria-pressed={mode === 'today'}
                  onClick={() => setMode('today')}
                >
                  <LightningChargeFill /> Today
                </button>
                <button
                  type="button"
                  className={mode === 'upcoming' ? 'active' : ''}
                  aria-pressed={mode === 'upcoming'}
                  onClick={() => setMode('upcoming')}
                >
                  <CalendarWeek /> Upcoming
                </button>
                <button
                  type="button"
                  className={mode === 'clubs' ? 'active' : ''}
                  aria-pressed={mode === 'clubs'}
                  onClick={() => setMode('clubs')}
                >
                  <People /> Groups
                </button>
              </div>
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
                    <img className="mb-empty-art" src="/images/art-nothing-here.webp" alt="" width="520" height="285" />
                    <h2>{mode === 'clubs' ? 'No groups yet.' : `Nothing ${windowLabel}.`}</h2>
                    {/* Only the upcoming mode has a window to widen; saying so
                        in the other two pointed at a control not on screen. */}
                    <p>
                      {mode === 'clubs' && 'Nothing has been listed yet.'}
                      {mode === 'today' && 'Nothing on today — try upcoming.'}
                      {mode === 'upcoming' && 'Try a wider window.'}
                    </p>
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
                    <img className="mb-empty-art" src="/images/art-deck-cleared.webp" alt="" width="420" height="420" />
                    <h2>{mode === 'clubs' ? "That's every group." : 'Deck cleared!'}</h2>
                    <p>
                      {mode === 'clubs'
                        ? 'You have seen them all.'
                        : `That's everything ${windowLabel}.`}
                    </p>
                    <div className="deck-empty-actions">
                      {passedCount > 0 && (
                        <Button className="btn-soft-primary" onClick={handleResetPassed}>
                          <ArrowCounterclockwise /> Replay {passedCount} passed
                        </Button>
                      )}
                      <Button as={Link} to="/user-events" className="btn-solid-primary">
                        <HeartFill /> {mode === 'clubs' ? 'View your groups' : 'View saved events'}
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

            <div className="swipe-actions match-swipe-actions" role="group" aria-label="Card actions">
              <motion.button
                type="button"
                className="swipe-btn swipe-btn-pass"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.86 }}
                onClick={() => startSwipe('left')}
                disabled={!topEvent}
                aria-label={mode === 'clubs' ? 'Pass on this group' : 'Pass on this event'}
                title="Pass (←)"
              >
                <XLg aria-hidden="true" />
              </motion.button>
              <motion.button
                type="button"
                className="swipe-btn swipe-btn-flip"
                whileHover={{ scale: 1.1, rotate: 12 }}
                whileTap={{ scale: 0.86 }}
                onClick={toggleFlip}
                disabled={!topEvent}
                aria-label={flippedId === topEvent?._id
                  ? `Show the front of this ${mode === 'clubs' ? 'group' : 'event'}`
                  : `Show details for this ${mode === 'clubs' ? 'group' : 'event'}`}
                aria-pressed={Boolean(topEvent && flippedId === topEvent._id)}
                title={flippedId === topEvent?._id ? 'Show front (↑ or Space)' : 'Show details (↑ or Space)'}
              >
                <ArrowRepeat aria-hidden="true" />
              </motion.button>
              <motion.button
                type="button"
                className="swipe-btn swipe-btn-save"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.86 }}
                onClick={() => startSwipe('right')}
                disabled={!topEvent}
                aria-label={mode === 'clubs' ? 'Save this group' : 'Save this event'}
                title="Save (→)"
              >
                <HeartFill aria-hidden="true" />
              </motion.button>
            </div>

            <div className="match-swipe-utilities">
              {/* Undo remains keyboard- and pointer-accessible without reading
                  as a fourth decision in the primary action group. */}
              <motion.button
                type="button"
                className="match-swipe-undo"
                whileHover={{ x: -2 }}
                whileTap={{ scale: 0.96 }}
                onClick={handleUndo}
                disabled={history.length === 0 || exiting.length > 0}
                aria-label="Undo last swipe"
                title="Undo last swipe (Z or Backspace)"
              >
                <ArrowCounterclockwise aria-hidden="true" />
                <span>Undo</span>
              </motion.button>
              {/* Said once, under the deck. The explicit middle button now
                  provides the same action for touch, mouse and keyboard users. */}
              {topEvent && (
                <p className="swipe-hint">
                  {flippedId === topEvent._id ? 'Tap the card to show the front' : 'Tap the card for details'}
                </p>
              )}
            </div>
          </div>
        </div>
      </Container>
    </MotionConfig>
  );
};

export default DiscoverEvents;
