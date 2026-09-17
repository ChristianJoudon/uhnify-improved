import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import PropTypes from 'prop-types';
import { Link, useSearchParams } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import swal from 'sweetalert';
import { Clubs } from '../../api/club/Club';
import { Events, NOT_CALLED_OFF } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import LoadingSpinner from '../components/LoadingSpinner';
import EventPoster from '../components/EventPoster';
import TopicPosters from '../components/TopicPosters';
import KindToggle from '../components/KindToggle';
import Club from '../components/Club';
import DetailsModal from '../components/DetailsModal';
import { normalizeCategories, sortByDate } from '../utilities/helpers';
import { topicForClub, topicForEvent } from '../utilities/topics';
import { collapseEventListings, eventListingCount } from '../utilities/eventSeries';
import { milesLabel, milesTo } from '../utilities/geo';
import { joinGroupAndTell, useRequestedGroupIds } from '../utilities/joinGroup';
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

/** Log a feed impression only after the card is at least half visible for 1s. */
const RecommendationMasonryItem = ({ children, entityId, entityType, index, metadata }) => {
  const ref = useRef(null);
  const sentKey = useRef('');

  useEffect(() => {
    if (!metadata?.requestId || !Number.isInteger(metadata.position) || !ref.current
      || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const key = `impression:${metadata.requestId}:${entityType}:${entityId}:${metadata.position}`;
    let timer = null;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5);
      if (!visible) {
        clearTimeout(timer);
        timer = null;
        return;
      }
      if (sentKey.current === key || timer) {
        return;
      }
      timer = setTimeout(() => {
        sentKey.current = key;
        Meteor.call('recommendationInteractions.record', {
          entityType,
          entityId,
          action: 'impression',
          clientEventId: key,
          requestId: metadata.requestId,
          position: metadata.position,
          displaySize: metadata.displaySize,
        });
      }, 1000);
    }, { threshold: [0.5] });
    observer.observe(ref.current);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [entityId, entityType, metadata?.requestId, metadata?.position, metadata?.displaySize]);

  return (
    <motion.div
      ref={ref}
      className="masonry-item"
      variants={rise}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-40px' }}
      custom={index}
    >
      {children}
    </motion.div>
  );
};

RecommendationMasonryItem.propTypes = {
  children: PropTypes.node.isRequired,
  entityId: PropTypes.string.isRequired,
  entityType: PropTypes.oneOf(['event', 'group']).isRequired,
  index: PropTypes.number.isRequired,
  metadata: PropTypes.shape({
    requestId: PropTypes.string,
    position: PropTypes.number,
    displaySize: PropTypes.string,
  }),
};

RecommendationMasonryItem.defaultProps = {
  metadata: null,
};

const compareRecommendationPosition = (left, right) => {
  const leftPosition = left.recommendationPosition;
  const rightPosition = right.recommendationPosition;
  if (Number.isInteger(leftPosition) && Number.isInteger(rightPosition)) {
    return leftPosition - rightPosition;
  }
  if (Number.isInteger(leftPosition)) {
    return -1;
  }
  if (Number.isInteger(rightPosition)) {
    return 1;
  }
  return right.score - left.score;
};

const Discover = () => {
  const userId = Meteor.userId();
  // The homepage finder arrives here as ?q= and ?when=, so what someone typed
  // on the front page is what they land on.
  const [params, setParams] = useSearchParams();
  const { origin } = useOrigin();
  const requestedIds = useRequestedGroupIds();
  const query = (params.get('q') || '').trim();
  const requested = params.get('when');
  const topicKey = params.get('topic');
  // Which kind of thing is being browsed. In the URL beside the other filters,
  // so a link carries the whole view.
  const kind = params.get('kind') === 'clubs' ? 'clubs' : 'events';
  // One sheet for either kind; the card that opened it says which.
  const [detail, setDetail] = useState(null);
  const [recommendationRuns, setRecommendationRuns] = useState({ event: null, group: null });
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

  const setKind = next => {
    const updated = new URLSearchParams(params);
    if (next === 'clubs') {
      updated.set('kind', 'clubs');
    } else {
      updated.delete('kind');
    }
    // A time window describes an event; it means nothing for a group.
    updated.delete('when');
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

  const { ready, events, clubs, swipes, joinedIds, interests, firstName } = useTracker(() => {
    const subs = [
      Meteor.subscribe(Events.userPublicationName),
      Meteor.subscribe(Clubs.userPublicationName),
      Meteor.subscribe(EventSwipes.userPublicationName),
      Meteor.subscribe(Profiles.userPublicationName),
      // Without this the card and the sheet both offered to join a group the
      // reader is already in.
      Meteor.subscribe(ProfileClubs.membershipPublicationName),
    ];
    const profile = Profiles.collection.findOne({ userId });
    return {
      ready: subs.every(sub => sub.ready()),
      events: Events.collection.find(NOT_CALLED_OFF).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      swipes: EventSwipes.collection.find({ userId }).fetch(),
      joinedIds: new Set(ProfileClubs.collection.find({ userId }).map(membership => membership.clubId)),
      interests: normalizeCategories(profile?.interests),
      firstName: profile?.firstName || '',
    };
  }, [userId]);

  const recommendationKind = kind === 'clubs' ? 'group' : 'event';

  useEffect(() => {
    if (!userId) {
      return undefined;
    }
    let active = true;
    Meteor.call('recommendations.get', {
      kind: recommendationKind,
      surface: 'discover_feed',
      limit: 100,
    }, (error, result) => {
      if (active) {
        setRecommendationRuns(current => ({
          ...current,
          [recommendationKind]: error || !result ? null : result,
        }));
      }
    });
    return () => {
      active = false;
    };
  }, [userId, recommendationKind, swipes.length, joinedIds.size]);

  const recommendationRun = recommendationRuns[recommendationKind];
  const recommendationById = useMemo(
    () => new Map((recommendationRun?.items || []).map(item => [item._id, item])),
    [recommendationRun],
  );

  const metadataFor = entityId => {
    const item = recommendationById.get(entityId);
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

  const goingIds = useMemo(
    () => new Set(swipes.filter(swipe => swipe.decision === 'going').map(swipe => swipe.eventId)),
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

    const inScopeEvents = upcoming
      .filter(event => inWindow(new Date(event.date), when))
      .filter(event => !needle || `${event.title} ${event.description || ''} ${event.location || ''}`
        .toLowerCase().includes(needle));

    return collapseEventListings(inScopeEvents)
      .map(event => {
        const host = clubByNumber.get(event.eventID);
        const topic = topicForEvent(event);
        const recommendation = recommendationById.get(event._id);
        const metadata = metadataFor(event._id);
        return {
          event: metadata ? { ...event, _recommendation: metadata } : event,
          host,
          topic,
          score: host ? scoreClub(host, context) : seedValue(event._id) / 997,
          recommendationPosition: recommendation?.position,
        };
      })
      .filter(item => !topicKey || item.topic.key === topicKey)
      .sort(compareRecommendationPosition);
  }, [upcoming, clubByNumber, interests, when, query, topicKey, recommendationById, recommendationRun]);

  /** The same wall, dealing groups. Ranked by fit, filtered by the same search. */
  const clubWall = useMemo(() => {
    const context = { interests, friendClubIds: new Set() };
    const needle = query.toLowerCase();
    return clubs
      .filter(club => !needle || `${club.name} ${club.description || ''} ${club.location || ''}`
        .toLowerCase().includes(needle))
      .map(club => {
        const topic = topicForClub(club);
        const recommendation = recommendationById.get(club._id);
        const metadata = metadataFor(club._id);
        return {
          club: metadata ? { ...club, _recommendation: metadata } : club,
          topic,
          score: scoreClub(club, context),
          recommendationPosition: recommendation?.position,
        };
      })
      .filter(item => !topicKey || item.topic.key === topicKey)
      .sort(compareRecommendationPosition);
  }, [clubs, interests, query, topicKey, recommendationById, recommendationRun]);

  /**
   * Counted before the category filter is applied, so a cover can say how much
   * is behind it without the act of opening one emptying all the others.
   */
  const topicCounts = useMemo(() => {
    const needle = query.toLowerCase();
    const tally = {};
    const inScopeEvents = upcoming
      .filter(event => inWindow(new Date(event.date), when))
      // Every filter the wall applies except the covers' own, search included —
      // it was counting past the search box, so a cover promised events the
      // query had already excluded.
      .filter(event => !needle || `${event.title} ${event.description || ''} ${event.location || ''}`
        .toLowerCase().includes(needle));
    collapseEventListings(inScopeEvents)
      .forEach(event => {
        tally[topicForEvent(event).key] = (tally[topicForEvent(event).key] || 0) + 1;
      });
    return tally;
  }, [upcoming, when, query]);

  /** Covers count whichever kind is being browsed, under the same search. */
  const clubTopicCounts = useMemo(() => {
    const needle = query.toLowerCase();
    const tally = {};
    clubs
      .filter(club => !needle || `${club.name} ${club.description || ''} ${club.location || ''}`
        .toLowerCase().includes(needle))
      .forEach(club => {
        tally[topicForClub(club).key] = (tally[topicForClub(club).key] || 0) + 1;
      });
    return tally;
  }, [clubs, query]);

  // In, asked, or refused: the shared helper says whichever it was. The
  // recommender's context rides along as before — and is only recorded for a
  // join that lands, since a request records no interaction at all.
  const join = clubId => {
    const metadata = metadataFor(clubId);
    const context = metadata ? { ...metadata, clientEventId: `join:${Random.id()}` } : {};
    joinGroupAndTell(clubId, { context });
  };

  // Taking it back from here is a person saying "not going", which is its own
  // fact. It used to be sent as 'undo' — the deck's word for rewinding a swipe
  // made a second ago — so a changed mind and a slipped thumb were recorded as
  // the same thing.
  const toggleGoing = event => {
    const isGoing = goingIds.has(event._id);
    const method = isGoing ? 'eventSwipes.remove' : 'eventSwipes.record';
    const args = isGoing ? [event._id, 'rsvp_canceled'] : [event._id, 'going', 'event'];
    const context = event._recommendation
      ? { ...event._recommendation, clientEventId: `feed-action:${Random.id()}` }
      : {};
    Meteor.call(method, ...args, context, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  const openDetail = (record, recordKind) => {
    if (record?._recommendation?.requestId) {
      Meteor.call('recommendationInteractions.record', {
        entityType: recordKind === 'club' ? 'group' : 'event',
        entityId: record._id,
        action: 'opened',
        clientEventId: `feed-open:${Random.id()}`,
        requestId: record._recommendation.requestId,
        position: record._recommendation.position,
        displaySize: record._recommendation.displaySize,
      });
    }
    setDetail({ record, kind: recordKind });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  /** Which of the two walls is on. Named once so the markup below can ask a
      single question at a time instead of nesting them. */
  const showingClubs = kind === 'clubs';

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
        <KindToggle value={kind} onChange={setKind} counts={{ events: eventListingCount(upcoming), clubs: clubs.length }} />
        {kind === 'events' && (
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
        )}
        <Link className="btn btn-match discover-swipe" to="/discover-events">Swipe instead</Link>
      </div>

      <TopicPosters
        selected={topicKey}
        onSelect={setTopic}
        counts={kind === 'clubs' ? clubTopicCounts : topicCounts}
      />

      {/* Three siblings rather than a ternary inside a ternary. The old shape
          asked two questions at once — which kind, and is it empty — and the
          reader had to hold the first while answering the second. */}
      {showingClubs && clubWall.length === 0 && (
        <div className="mb-empty">
          <h3>{query ? `No groups matching “${query}”.` : 'No groups here.'}</h3>
          <p>Try a different category, or start one yourself.</p>
          <Link className="btn btn-solid-primary" to="/create-club">Start a group</Link>
        </div>
      )}

      {showingClubs && clubWall.length > 0 && (
        <div className="masonry discover-wall">
          {clubWall.map(({ club }, index) => (
            <RecommendationMasonryItem
              key={club._id}
              entityId={club._id}
              entityType="group"
              index={index}
              metadata={club._recommendation}
            >
              <Club
                club={club}
                tier={index < 2 ? 'lg' : 'md'}
                distance={milesLabel(milesTo(club, origin))}
                isMember={joinedIds.has(club._id)}
                isRequested={requestedIds.has(club._id)}
                onAddToProfile={join}
                onViewDetails={() => openDetail(club, 'club')}
              />
            </RecommendationMasonryItem>
          ))}
        </div>
      )}

      {!showingClubs && wall.length === 0 && (
        <div className="mb-empty">
          <h3>{query ? `Nothing matching “${query}”.` : 'Nothing in that window.'}</h3>
          <p>Try a wider stretch of time, or start something yourself.</p>
          <Link className="btn btn-solid-primary" to="/create-event">Start an event</Link>
        </div>
      )}

      {!showingClubs && wall.length > 0 && (
        <div className="masonry discover-wall">
          {wall.map(({ event }, index) => {
            const miles = milesTo(event, origin);
            return (
              <RecommendationMasonryItem
                key={event._id}
                entityId={event._id}
                entityType="event"
                index={index}
                metadata={event._recommendation}
              >
                <EventPoster
                  event={event}
                  distance={milesLabel(miles)}
                  going={goingIds.has(event._id)}
                  onGoing={toggleGoing}
                  onOpen={() => openDetail(event, 'event')}
                  // The top few are drawn large, so the wall has a focal point
                  // instead of reading as a uniform grid.
                  tier={index < 2 ? 'lg' : 'md'}
                />
              </RecommendationMasonryItem>
            );
          })}
        </div>
      )}

      <DetailsModal
        show={Boolean(detail)}
        onHide={() => setDetail(null)}
        record={detail?.record}
        kind={detail?.kind || 'club'}
        isIn={detail?.kind === 'event'
          ? goingIds.has(detail?.record?._id)
          : joinedIds.has(detail?.record?._id)}
        requested={detail?.kind === 'club' && requestedIds.has(detail?.record?._id)}
        onAct={detail?.kind === 'event' ? toggleGoing : record => join(record._id)}
      />
    </main>
  );
};

export default Discover;
