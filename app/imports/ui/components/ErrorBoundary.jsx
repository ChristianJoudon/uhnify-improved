import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Catches a render error in whichever page is on screen and shows a calm
 * notice in its place, with the nav and footer still working around it.
 * Without this, one throw anywhere under <Routes> unmounts the entire React
 * tree and the reader is left with a white page whose only exit is the
 * address bar.
 *
 * A class because that is the only kind of component React lets catch render
 * errors; everything else in the app is a function component. The router
 * hooks it needs come in as props from the wrapper below.
 */
class RouteErrorBoundary extends React.Component {
  static getDerivedStateFromError(error) {
    return { error };
  }

  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  componentDidCatch(error, info) {
    // The component stack is the part window.onerror never sees, and it is
    // what says which page broke.
    // eslint-disable-next-line no-console
    console.error(error, info.componentStack);
    // montiapm:agent, once it has credentials. Its client agent stamps every
    // report `type: 'client'` on its own; the subType is what separates a
    // render crash from the uncaught errors it already collects itself.
    const apm = window.Monti || window.Kadira;
    if (apm && typeof apm.trackError === 'function') {
      apm.trackError(error, { type: 'client', subType: 'react-render' });
    }
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  handleGoHome = () => {
    const { navigate } = this.props;
    navigate('/');
    // Moving to another path gives the wrapper a new key and a fresh boundary,
    // but not when the page that broke was home itself — the path is the same
    // one. Clearing the error here covers that case.
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children } = this.props;
    if (!error) {
      return children;
    }
    return (
      <Container className="page-shell page-notice py-5">
        <section className="mb-error-panel" role="alert">
          <h1>Something went wrong on this page.</h1>
          <p>Nothing you did caused it. Try again, or head home and come back to this later.</p>
          {Meteor.isDevelopment && <pre>{error.message}</pre>}
          <div className="mb-error-panel-actions">
            <button type="button" className="btn btn-solid-primary" onClick={this.handleRetry}>Try again</button>
            <button type="button" className="btn btn-soft-primary" onClick={this.handleGoHome}>Go home</button>
          </div>
        </section>
      </Container>
    );
  }
}

RouteErrorBoundary.propTypes = {
  navigate: PropTypes.func.isRequired,
  children: PropTypes.node,
};

RouteErrorBoundary.defaultProps = {
  children: null,
};

/**
 * Keyed on the pathname so a broken page does not follow the reader to the
 * next one: the caught error lives in the class's state, and the only way to
 * clear state a class is holding from outside is to hand React a new instance.
 * The cost is that everything under the boundary remounts on every path
 * change; pages already do when the route changes, so the difference is only
 * felt between two params of the same route, which nothing here links between.
 */
const ErrorBoundary = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <RouteErrorBoundary key={location.pathname} navigate={navigate}>
      {children}
    </RouteErrorBoundary>
  );
};

ErrorBoundary.propTypes = {
  children: PropTypes.node,
};

ErrorBoundary.defaultProps = {
  children: null,
};

export default ErrorBoundary;
