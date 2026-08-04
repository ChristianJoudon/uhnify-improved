import React from 'react';
import PropTypes from 'prop-types';

/**
 * The MatchBook wordmark: drawn serif letterforms in the match orange.
 *
 * Two cuts of the same name, and the difference is where they sit. The header
 * carries the name alone — a struck match ruled under it reads as an underline
 * at 1.55rem, and an underline in the top-left corner of every screen reads as
 * a link that is not one. The footer keeps the struck match, because down there
 * it is a sign-off rather than a control and has the room to be one.
 *
 * Both files are cut to the ink with no surrounding padding, so the CSS height
 * is the height of the mark itself and every surface sizes it against its own
 * type. Both are also deliberately named differently from the marks they
 * replaced: serving new artwork from an old path means every returning reader
 * keeps the previous one out of their cache until it expires — the one change
 * nobody would think to hard-refresh for.
 */
const MARKS = {
  plain: '/images/matchbook-wordmark.png',
  struck: '/images/matchbook-logo.png',
};

const Wordmark = ({ className, mark }) => (
  <img
    src={MARKS[mark]}
    alt="MatchBook"
    className={`mb-wordmark ${className}`.trim()}
  />
);

Wordmark.propTypes = {
  className: PropTypes.string,
  /** `plain` is the name on its own; `struck` rules a lit match beneath it. */
  mark: PropTypes.oneOf(['plain', 'struck']),
};

Wordmark.defaultProps = {
  className: '',
  mark: 'plain',
};

export default Wordmark;
