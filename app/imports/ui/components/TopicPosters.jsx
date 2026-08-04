import React from 'react';
import PropTypes from 'prop-types';
import { motion } from 'framer-motion';
import { TOPICS, TOPIC_KEYS } from '../utilities/topics';

/**
 * The eight categories, as their covers.
 *
 * The cover is composed rather than painted. It used to be one of eight
 * 800x1000 JPEGs with the category name and tagline burnt into the pixels —
 * the only painterly rasters in an app whose identity is flat drawn shapes,
 * and the only place a third typeface appeared. Worse, the name was then set a
 * SECOND time as live text directly underneath, so every cover said its own
 * name twice in two different faces, and the raster half could not reflow,
 * could not be translated, and was being cropped by the compact rail.
 *
 * It is now made of parts TOPICS already owns: the pastel field as the ground,
 * the drawn illustration as the subject, and the label, tagline and count as
 * real type. The same recipe every card in the app already follows.
 */

/**
 * "Move & Explore" reads as two words joined, not three. Setting the ampersand
 * on its own line, small, lets both halves start at the left margin at full
 * size — a title rather than a label that happens to wrap.
 */
const Title = ({ label }) => {
  const parts = label.split(' & ');
  if (parts.length !== 2) {
    return <span className="topic-poster-name">{label}</span>;
  }
  return (
    <span className="topic-poster-name">
      {parts[0]}
      <span className="topic-poster-amp" aria-hidden="true">&amp;</span>
      {parts[1]}
    </span>
  );
};

Title.propTypes = { label: PropTypes.string.isRequired };

const TopicPosters = ({ selected, onSelect, counts, compact }) => (
  <ul className={`topic-posters${compact ? ' is-compact' : ''}`}>
    {TOPIC_KEYS.map((key, index) => {
      const topic = TOPICS[key];
      const on = selected === key;
      const count = counts ? counts[key] : undefined;
      return (
        <motion.li
          key={key}
          initial={{ opacity: 0, y: 12 }}
          // Not whileInView: this row scrolls sideways, and an intersection
          // observer measures against the viewport, so the covers past the
          // right edge never counted as seen and sat at opacity 0 until the
          // reader scrolled — two of the eight, on a 1280px screen.
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <button
            type="button"
            className={`topic-poster${on ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => onSelect(on ? null : key)}
          >
            {/* The first wash, always. The second exists so a wall of many
                cards in one category reads with rhythm; a rail of eight
                covers, one per topic, has that rhythm already and wants to be
                the same colour on every visit. */}
            <span className="topic-poster-plate" style={{ background: topic.fields[0] }}>
              {/* alt="" because the name is real text right below it now. It
                  was not before — it was pixels, and the button's accessible
                  name came from the tagline. */}
              <img className="topic-poster-art" src={topic.icon} alt="" loading="lazy" />
            </span>
            <span className="topic-poster-body">
              <Title label={topic.label} />
              <span className="topic-poster-tagline">{topic.tagline}</span>
            </span>
            {count !== undefined && (
              <span className="topic-poster-count">
                {count === 0 ? 'Nothing right now' : `${count} on`}
              </span>
            )}
          </button>
        </motion.li>
      );
    })}
  </ul>
);

TopicPosters.propTypes = {
  selected: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
  counts: PropTypes.objectOf(PropTypes.number),
  /** Nearby's covers are a filter under a map, not the way in, so they run small. */
  compact: PropTypes.bool,
};

TopicPosters.defaultProps = {
  selected: null,
  counts: null,
  compact: false,
};

export default TopicPosters;
