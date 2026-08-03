import React from 'react';
import PropTypes from 'prop-types';

/**
 * The MatchBook wordmark: drawn serif letterforms in the match orange, the "t"
 * of Match standing in as an upright match — charcoal head, three short sparks
 * above it.
 *
 * Artwork rather than type-plus-SVG now, because the letterforms carry a
 * hand-drawn character no available typeface did. The file is cut to the ink
 * with no surrounding padding, so the CSS height is the height of the mark
 * itself and every surface can size it against its own type.
 */
const Wordmark = ({ className }) => (
  <img
    src="/images/matchbook-wordmark.png"
    alt="MatchBook"
    className={`mb-wordmark ${className}`.trim()}
  />
);

Wordmark.propTypes = {
  className: PropTypes.string,
};

Wordmark.defaultProps = {
  className: '',
};

export default Wordmark;
