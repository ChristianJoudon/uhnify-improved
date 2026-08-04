import React, { useRef } from 'react';
import PropTypes from 'prop-types';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import { ArrowLeft, CalendarEvent, GeoAlt, InfoCircle, People } from 'react-bootstrap-icons';
import CardFields from './CardFields';
import { CLUB_FIELDS, EVENT_FIELDS } from '../utilities/cardFields';
import { formatEventDate, formatShortDate } from '../utilities/helpers';
import { topicForEvent } from '../utilities/topics';

const SWIPE_DISTANCE = 130;
const SWIPE_VELOCITY = 650;

const flyDistance = () => (typeof window !== 'undefined' ? window.innerWidth + 200 : 1200);

const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const daysUntilLabel = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  // Calendar-day difference, so a 8pm event still reads "Today!" at 2pm.
  const days = Math.round((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / (24 * 60 * 60 * 1000));
  if (days < 0) {
    return 'Already started';
  }
  if (days === 0) {
    return 'Today!';
  }
  if (days === 1) {
    return 'Tomorrow';
  }
  return `In ${days} days`;
};

/**
 * One card in the Discover deck. The top card can be dragged left/right to decide,
 * double-tapped to flip over for full details, and flies off screen when a decision lands.
 */
const SwipeCard = ({ event, hostName, kind, stackIndex, exitDirection, flipped, onSwipe, onFlip, onExited }) => {
  // A group and an event are the same object to this card — a thing with a
  // topic, a place and a time — so only the field schema differs.
  const fields = kind === 'club' ? CLUB_FIELDS : EVENT_FIELDS;
  // Same rule as every other card: the seeded stock art is not this app's
  // design, so only a genuinely uploaded photo becomes the card face. The
  const topic = topicForEvent(event);
  const photo = event.image && event.image.startsWith('data:') ? event.image : '';

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-340, 340], [-17, 17]);
  const likeOpacity = useTransform(x, [36, SWIPE_DISTANCE], [0, 1]);
  const passOpacity = useTransform(x, [-SWIPE_DISTANCE, -36], [1, 0]);
  const dragging = useRef(false);
  // The fly-off target is captured once per exit so mid-flight re-renders
  // (e.g. the swipe record landing in minimongo) cannot retarget the animation.
  const exitTarget = useRef(null);

  const isTop = stackIndex === 0 && !exitDirection;
  const exitSign = exitDirection === 'right' ? 1 : -1;
  if (exitDirection && !exitTarget.current) {
    exitTarget.current = { x: exitSign * flyDistance(), y: y.get() * 1.4 };
  } else if (!exitDirection && exitTarget.current) {
    exitTarget.current = null;
  }
  // A tiny deterministic tilt so the resting deck looks like a hand-stacked pile.
  const restingTilt = stackIndex === 0 ? 0 : (event._id.charCodeAt(0) % 2 === 0 ? 1 : -1) * 1.4 * stackIndex;

  const handleDragStart = () => {
    dragging.current = true;
  };

  const handleDragEnd = (domEvent, info) => {
    // onTap fires right after this when the pointer is still over the card
    // (it usually is, since the card follows the finger), so clear the flag a tick later.
    setTimeout(() => {
      dragging.current = false;
    }, 0);
    if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) {
      onSwipe('right');
    } else if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY) {
      onSwipe('left');
    }
  };

  /**
   * A single tap turns the card over. It used to take a double-tap, which is a
   * gesture nobody finds — the affordance has to be the obvious one, and the
   * card itself is the biggest target on the screen. `dragging` keeps a
   * short drag that snapped back from counting as a tap.
   */
  const handleTap = () => {
    if (!isTop || dragging.current) {
      return;
    }
    onFlip();
  };

  return (
    <motion.div
      className="swipe-card-slot"
      /* backface-visibility and pointer-events hide the buried cards and the
         face-down side from the eye and the mouse; neither touches the
         accessibility tree. Without this a screen reader read all four stacked
         cards, both faces of each — eight headings for one visible card, one of
         them at opacity 0 — with no way to tell which the keys would act on. */
      aria-hidden={!isTop && !exitDirection}
      style={{ zIndex: exitDirection ? 30 : 20 - stackIndex }}
      initial={{ y: 30 + stackIndex * 16, scale: 0.86, opacity: 0 }}
      animate={exitDirection
        ? { y: 0, scale: 1, rotate: 0, opacity: 1 }
        : { y: stackIndex * 16, scale: 1 - stackIndex * 0.055, rotate: restingTilt, opacity: stackIndex > 2 ? 0 : 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 24 }}
    >
      <motion.div
        className={`swipe-card${isTop ? ' is-top' : ''}`}
        style={{ x, y, rotate, pointerEvents: isTop ? 'auto' : 'none' }}
        drag={isTop}
        dragMomentum={false}
        dragSnapToOrigin
        dragTransition={{ bounceStiffness: 480, bounceDamping: 32 }}
        whileTap={isTop ? { scale: 0.985 } : undefined}
        whileDrag={{ scale: 1.045 }}
        onDragStart={isTop ? handleDragStart : undefined}
        onDragEnd={isTop ? handleDragEnd : undefined}
        onTap={handleTap}
        animate={exitDirection ? exitTarget.current : { x: 0, y: 0 }}
        transition={exitDirection
          ? { type: 'spring', stiffness: 170, damping: 26 }
          : { type: 'spring', stiffness: 480, damping: 32 }}
        onAnimationComplete={definition => {
          // Fires for every animation on this element, including the whileTap/whileDrag
          // scale reset after a drag release — only the fly-off (a large x target) counts
          // as "exited". Structural check, because framer may merge or clone the target
          // object when a gesture reset batches with the exit animation.
          if (exitDirection && definition && typeof definition === 'object' && Math.abs(definition.x || 0) > 200) {
            onExited(event._id, exitDirection);
          }
        }}
      >
        <motion.div
          className="swipe-card-inner"
          animate={{ rotateY: flipped && isTop ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        >
          <div className="swipe-card-face swipe-card-front" aria-hidden={flipped}>
            <div
              className={`swipe-card-media${photo ? ' has-photo' : ''}`}
              style={photo ? undefined : { background: topic.field, color: topic.ink }}
            >
              {photo
                ? <img src={photo} alt={event.title} draggable={false} />
                : <img className="swipe-card-motif" src={topic.icon} alt="" />}
              {/* A group has no single date, so its card carries neither pill —
                  the same rule as everywhere else: no data, no element. */}
              {event.date && <span className="swipe-pill swipe-pill-date">{formatShortDate(event.date)}</span>}
              {event.date && <span className="swipe-pill swipe-pill-countdown">{daysUntilLabel(event.date)}</span>}
              <div className="swipe-card-headline">
                {hostName && <span className="swipe-host-chip"><People size={13} /> {hostName}</span>}
                <h3>{event.title}</h3>
              </div>
            </div>
            <div className="swipe-card-body">
              {(event.date || event.meetingTime) && (
                <div className="meta-line">
                  <CalendarEvent size={15} /> {event.date ? formatEventDate(event.date) : event.meetingTime}
                </div>
              )}
              {event.location && <div className="meta-line"><GeoAlt size={15} /> {event.location}</div>}
            </div>
            {/* Says what turning the card over gets you — details — rather than
                naming the mechanism. The whole card is the real hit area; this
                is what makes that discoverable. */}
            <span className="swipe-info" aria-hidden="true"><InfoCircle size={17} /></span>
          </div>
          <div className="swipe-card-face swipe-card-back" aria-hidden={!flipped}>
            <span className="swipe-info swipe-info-back" aria-hidden="true"><ArrowLeft size={17} /></span>
            <h3>{event.title}</h3>
            {/* The back was hand-written rows with fallbacks, so a listing with
                no host printed "Club #0" and one with no text printed "No
                description yet." It reads the same schema as every other card
                now: a row exists only when the listing published it. This is
                also the surface with room for cost, audience and registration,
                which the front has to leave out. */}
            <CardFields record={{ ...event, hostName }} schema={fields} className="swipe-card-facts" />
            {event.description && <p className="swipe-card-description">{event.description}</p>}
          </div>
        </motion.div>
        <motion.div className="swipe-stamp swipe-stamp-like" style={{ opacity: exitDirection === 'right' ? 1 : likeOpacity }}>
          Saved
        </motion.div>
        <motion.div className="swipe-stamp swipe-stamp-pass" style={{ opacity: exitDirection === 'left' ? 1 : passOpacity }}>
          Pass
        </motion.div>
      </motion.div>
    </motion.div>
  );
};

SwipeCard.propTypes = {
  event: PropTypes.shape({
    _id: PropTypes.string,
    title: PropTypes.string,
    description: PropTypes.string,
    date: PropTypes.instanceOf(Date),
    location: PropTypes.string,
    createdBy: PropTypes.string,
    eventID: PropTypes.number,
    image: PropTypes.string,
  }).isRequired,
  hostName: PropTypes.string,
  /** 'event' or 'club' — decides which field schema the back reads. */
  kind: PropTypes.oneOf(['event', 'club']),
  stackIndex: PropTypes.number.isRequired,
  exitDirection: PropTypes.oneOf(['left', 'right']),
  flipped: PropTypes.bool,
  onSwipe: PropTypes.func.isRequired,
  onFlip: PropTypes.func.isRequired,
  onExited: PropTypes.func.isRequired,
};

SwipeCard.defaultProps = {
  hostName: '',
  kind: 'event',
  exitDirection: null,
  flipped: false,
};

export default SwipeCard;
