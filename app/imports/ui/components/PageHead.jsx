import React, { useEffect } from 'react';
import PropTypes from 'prop-types';

/**
 * How every page opens. There were eight different treatments across the
 * twenty-one routes — some with a card behind the title, some centred, three
 * with no h1 at all — so a page's identity depended on which week it was built.
 *
 * `action` is the one control that belongs beside a title rather than in the
 * page body: "Edit", "Start swiping". Anything more than one belongs in a
 * toolbar underneath.
 */
const PageHead = ({ title, children, action, eyebrow }) => {
  // The tab reads the page's name, not the same word on every route — it is
  // what a screen reader announces on arrival and what a bookmark is called.
  useEffect(() => {
    const name = typeof title === 'string' ? title : '';
    document.title = name ? `${name} · MatchBook` : 'MatchBook';
    return () => { document.title = 'MatchBook'; };
  }, [title]);
  return (
    <header className="page-intro">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <div className="page-intro-row">
        <h1>{title}</h1>
        {action}
      </div>
      {children && <p>{children}</p>}
    </header>
  );
};

PageHead.propTypes = {
  title: PropTypes.node.isRequired,
  /** The standfirst. One sentence — it is not a place for instructions. */
  children: PropTypes.node,
  action: PropTypes.node,
  eyebrow: PropTypes.string,
};

PageHead.defaultProps = {
  children: null,
  action: null,
  eyebrow: '',
};

export default PageHead;
