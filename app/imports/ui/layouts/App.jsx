import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Roles } from 'meteor/alanning:roles';
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import Landing from '../pages/Landing';
import NotFound from '../pages/NotFound';
import SignUp from '../pages/SignUp';
import SignOut from '../pages/SignOut';
import NavBar from '../components/NavBar';
import SignIn from '../pages/SignIn';
import NotAuthorized from '../pages/NotAuthorized';
import LoadingSpinner from '../components/LoadingSpinner';
import ClubDetail from '../pages/ClubDetail';
import ListClubs from '../pages/ListClubs';
import ListEvents from '../pages/ListEvents';
import DiscoverEvents from '../pages/DiscoverEvents';
import Agenda from '../pages/Agenda';
import ListClubAdmin from '../pages/ListClubAdmin';
import ClubFinder from '../pages/ClubFinder';
import Footer from '../components/Footer';
import ProfileSettings from '../pages/Profile';
import AddClub from '../pages/AddClub';
import MyEvents from '../pages/MyEvents';
import AddEvent from '../pages/AddEvent';
import Profile from '../pages/Profilez';
import EditClubAdmin from '../pages/EditClubAdmin';
import EditEventAdmin from '../pages/EditEventAdmin';

const ProtectedRoute = ({ children }) => {
  const isLogged = Meteor.userId() !== null;
  return isLogged ? children : <Navigate to="/signin" />;
};

const AdminProtectedRoute = ({ ready, children }) => {
  const isLogged = Meteor.userId() !== null;
  if (!isLogged) {
    return <Navigate to="/signin" />;
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
    <Router>
      <div className="app-shell d-flex flex-column min-vh-100">
        <NavBar />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/signout" element={<SignOut />} />
          <Route path="/home" element={<ProtectedRoute><Landing /></ProtectedRoute>} />
          <Route path="/upcoming-events" element={<ListEvents />} />
          <Route path="/discover-events" element={<ProtectedRoute><DiscoverEvents /></ProtectedRoute>} />
          <Route path="/agenda" element={<ProtectedRoute><Agenda /></ProtectedRoute>} />
          <Route path="/my-clubs" element={<ProtectedRoute><ListClubs /></ProtectedRoute>} />
          <Route path="/search-clubs" element={<ProtectedRoute><ClubFinder /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/profilez" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><ProfileSettings /></ProtectedRoute>} />
          <Route path="/edit/:_id" element={<AdminProtectedRoute ready={ready}><EditClubAdmin /></AdminProtectedRoute>} />
          <Route path="/edit/event/:_id" element={<AdminProtectedRoute ready={ready}><EditEventAdmin /></AdminProtectedRoute>} />
          <Route path="/user-events" element={<ProtectedRoute><MyEvents /></ProtectedRoute>} />
          <Route path="/clubdetail" element={<ClubDetail />} />
          <Route path="/create-club" element={<ProtectedRoute><AddClub /></ProtectedRoute>} />
          <Route path="/create-event" element={<ProtectedRoute><AddEvent /></ProtectedRoute>} />
          <Route path="/admin" element={<AdminProtectedRoute ready={ready}><ListClubAdmin /></AdminProtectedRoute>} />
          <Route path="/notauthorized" element={<NotAuthorized />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <Footer />
      </div>
    </Router>
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
