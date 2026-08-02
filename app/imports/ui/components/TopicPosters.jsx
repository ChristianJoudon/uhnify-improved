import React from 'react';
import PropTypes from 'prop-types';
import { motion } from 'framer-motion';
import { TOPICS, TOPIC_KEYS } from '../utilities/topics';

/**
 * The eight categories, as their covers.
 *
 * This is the one surface where the artwork belongs: a cover says what a whole
 * category feels like, which is worth a poster once and worth nothing repeated
 * across two hundred event cards. Everything is read from TOPICS, so a ninth
 * category appears here the moment it exists.
 *
 * `counts` is optional — a category with nothing in it right now still shows,
 * but says so, rather than being hidden or claiming a zero.
 */
const TopicPosters = ({ selected, onSelect, counts }) => (
  <ul className="topic-posters">
    {TOPIC_KEYS.map((key, index) => {
      const topic = TOPICS[key];
      const on = selected === key;
      const count = counts ? counts[key] : undefined;
      return (
        <motion.li
          key={key}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <button
            type="button"
            className={`topic-poster${on ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => onSelect(on ? null : key)}
          >
            <img src={topic.poster} alt="" loading="lazy" />
            <span className="topic-poster-body">
              <span className="topic-poster-name">{topic.label}</span>
              <span className="topic-poster-tagline">{topic.tagline}</span>
              {count !== undefined && (
                <span className="topic-poster-count">
                  {count === 0 ? 'Nothing right now' : `${count} on`}
                </span>
              )}
            </span>
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
};

TopicPosters.defaultProps = {
  selected: null,
  counts: null,
};

export default TopicPosters;
