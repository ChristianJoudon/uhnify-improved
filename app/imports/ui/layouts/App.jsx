import React, { Suspense, lazy, useEffect } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Roles } from 'meteor/alanning:roles';
import { BrowserRouter as Router, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import Landing from '../pages/Landing';
import NotFound from '../pages/NotFound';
import SignUp from '../pages/SignUp';
import SignOut from '../pages/SignOut';
import NavBar from '../components/NavBar';
import SignIn from '../pages/SignIn';
import ForgotPassword from '../pages/ForgotPassword';
import ResetPassword from '../pages/ResetPassword';
import VerifyEmail from '../pages/VerifyEmail';
import LegalPage from '../pages/LegalPage';
import ListingPage from '../pages/ListingPage';
import Help from '../pages/Help';
import EmergencyBanner from '../components/EmergencyBanner';
import NotAuthorized from '../pages/NotAuthorized';
import LoadingSpinner from '../components/LoadingSpinner';
import ListClubs from '../pages/ListClubs';
import ListEvents from '../pages/ListEvents';
import DiscoverEvents from '../pages/DiscoverEvents';
import Discover from '../pages/Discover';
import Agenda from '../pages/Agenda';
import ClubFinder from '../pages/ClubFinder';
import Footer from '../components/Footer';
import ErrorBoundary from '../components/ErrorBoundary';
import ProfileSettings from '../pages/Settings';
import AddClub from '../pages/AddClub';
import MyEvents from '../pages/MyEvents';
import AddEvent from '../pages/AddEvent';
import Profile from '../pages/Profile';
import EditClubAdmin from '../pages/EditClubAdmin';
import EditEventAdmin from '../pages/EditEventAdmin';
import ManageGroup from '../pages/ManageGroup';
import ManageEvent from '../pages/ManageEvent';
import JoinGroup from '../pages/JoinGroup';
import { rememberReturnTo } from '../utilities/returnTo';
// Administrators' pages, loaded only when an administrator opens one. They
// are a large share of the client and nobody else can use them.
const ListClubAdmin = lazy(() => import('../pages/ListClubAdmin'));
const EventIntake = lazy(() => import('../pages/EventIntake.jsx'));
const EventReview = lazy(() => import('../pages/EventReview.jsx'));
const HelpAdmin = lazy(() => import('../pages/HelpAdmin'));
// Keep the extension explicit because this page has a same-basename CSS module;
// Meteor's resolver can otherwise hand React the stylesheet module object.

/**
 * To the sign-in page, leaving a note of where the person was headed.
 *
 * The note is what makes an invite link work for somebody with no account:
 * `/join/<token>` bounces them here, and without it signing in landed on the
 * front page with the link gone. Sign in and sign up both read it back (see
 * utilities/returnTo). It is written in an effect, which runs for the render
 * that redirects and not for one React threw away.
 */
const ToSignIn = () => {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    rememberReturnTo(`${pathname}${search}${hash}`);
  }, [pathname, search, hash]);
  return <Navigate to="/signin" />;
};

const ProtectedRoute = ({ children }) => {
  const isLogged = Meteor.userId() !== null;
  return isLogged ? children : <ToSignIn />;
};

const AdminProtectedRoute = ({ ready, children }) => {
  const isLogged = Meteor.userId() !== null;
  if (!isLogged) {
    return <ToSignIn />;
  }
  if (!ready) {
    return <LoadingSpinner />;
  }
  const isAdmin = Roles.userIsInRole(Meteor.userId(), 'admin');
  return (isLogged && isAdmin) ? children : <Navigate to="/notauthorized" />;
};

const App = () => {
  const { ready } = useTracker(() => ({ ready: Roles.subscription.ready() }));
  return (
    // Reduced motion is a preference about the whole app, not about whichever
    // page last remembered to ask for it.
    <MotionConfig reducedMotion="user">
      <Router>
        <div className="app-shell d-flex flex-column min-vh-100">
          <EmergencyBanner />
          <NavBar />
          {/* Inside the Router, so the boundary can watch the route and reset
              on navigation; around only the page, so the nav and footer stay
              on screen and usable when a page's render throws. */}
          <ErrorBoundary>
            <Suspense fallback={<LoadingSpinner />}>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/signin" element={<SignIn />} />
                <Route path="/signup" element={<SignUp />} />
                <Route path="/signout" element={<SignOut />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password/:token" element={<ResetPassword />} />
                <Route path="/verify-email/:token" element={<VerifyEmail />} />
                {/* A listing's own address — what somebody texts a friend. */}
                <Route path="/e/:_id" element={<ListingPage kind="event" />} />
                <Route path="/g/:_id" element={<ListingPage kind="club" />} />
                <Route path="/help" element={<Help />} />
                <Route path="/admin/help" element={<AdminProtectedRoute ready={ready}><HelpAdmin /></AdminProtectedRoute>} />
                <Route path="/privacy" element={<LegalPage which="privacy" />} />
                <Route path="/terms" element={<LegalPage which="terms" />} />
                <Route path="/home" element={<ProtectedRoute><Landing /></ProtectedRoute>} />
                <Route path="/upcoming-events" element={<ListEvents />} />
                <Route path="/discover" element={<ProtectedRoute><Discover /></ProtectedRoute>} />
                <Route path="/discover-events" element={<ProtectedRoute><DiscoverEvents /></ProtectedRoute>} />
                <Route path="/agenda" element={<ProtectedRoute><Agenda /></ProtectedRoute>} />
                <Route path="/saved" element={<ProtectedRoute><ListClubs /></ProtectedRoute>} />
                <Route path="/my-clubs" element={<ProtectedRoute><ListClubs /></ProtectedRoute>} />
                <Route path="/search-clubs" element={<ProtectedRoute><ClubFinder /></ProtectedRoute>} />
                <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                <Route path="/profilez" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute><ProfileSettings /></ProtectedRoute>} />
                <Route path="/edit/:_id" element={<ProtectedRoute><EditClubAdmin /></ProtectedRoute>} />
                <Route path="/edit/event/:_id" element={<ProtectedRoute><EditEventAdmin /></ProtectedRoute>} />
                <Route path="/user-events" element={<ProtectedRoute><MyEvents /></ProtectedRoute>} />
                {/* Was a generic "About" panel with no inbound link anywhere in the
                  app. Kept as a redirect so an old bookmark lands somewhere real
                  instead of on the 404. */}
                <Route path="/clubdetail" element={<Navigate to="/" replace />} />
                <Route path="/create-club" element={<ProtectedRoute><AddClub /></ProtectedRoute>} />
                <Route path="/create-event" element={<ProtectedRoute><AddEvent /></ProtectedRoute>} />
                {/* A listing's own page, for the person who runs it. Signed-in is
                  all the route can check; whether this listing is THEIRS is the
                  page's question, because only its subscription can answer it. */}
                <Route path="/manage/group/:_id" element={<ProtectedRoute><ManageGroup /></ProtectedRoute>} />
                <Route path="/manage/event/:_id" element={<ProtectedRoute><ManageEvent /></ProtectedRoute>} />
                {/* Where an invite link lands. Protected like any other page, and
                  the reason the guard now remembers where it was asked for. */}
                <Route path="/join/:token" element={<ProtectedRoute><JoinGroup /></ProtectedRoute>} />
                <Route path="/admin" element={<AdminProtectedRoute ready={ready}><ListClubAdmin /></AdminProtectedRoute>} />
                <Route path="/admin/event-intake" element={<AdminProtectedRoute ready={ready}><EventIntake /></AdminProtectedRoute>} />
                <Route path="/admin/event-intake/review" element={<AdminProtectedRoute ready={ready}><EventReview /></AdminProtectedRoute>} />
                <Route path="/notauthorized" element={<NotAuthorized />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
          <Footer />
        </div>
      </Router>
    </MotionConfig>
  );
};

ProtectedRoute.propTypes = {
  children: PropTypes.oneOfType([PropTypes.object, PropTypes.func, PropTypes.node]),
};

ProtectedRoute.defaultProps = {
  children: <Landing />,
};

AdminProtectedRoute.propTypes = {
  ready: PropTypes.bool,
  children: PropTypes.oneOfType([PropTypes.object, PropTypes.func, PropTypes.node]),
};

AdminProtectedRoute.defaultProps = {
  ready: false,
  children: <Landing />,
};

export default App;
