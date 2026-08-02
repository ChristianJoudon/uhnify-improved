import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { Roles } from 'meteor/alanning:roles';
import { Meteor } from 'meteor/meteor';
import { Container, Image, Nav, Navbar, NavDropdown } from 'react-bootstrap';
import { Gear, PersonCircle } from 'react-bootstrap-icons';
import { Profiles } from '../../api/profiles/Profiles';
import MatchMark from './brand/MatchMark';
import Wordmark from './brand/Wordmark';
import { profileImagePath } from '../utilities/helpers';

const NavBar = () => {
  const { currentUser, userId, isAdmin } = useTracker(() => ({
    currentUser: Meteor.user() ? Meteor.user().username : '',
    userId: Meteor.userId(),
    isAdmin: Roles.userIsInRole(Meteor.userId(), 'admin'),
  }), []);

  const { profile } = useTracker(() => {
    if (!Meteor.userId()) {
      return { ready: true, profile: null };
    }
    Meteor.subscribe(Profiles.userPublicationName);
    return {
      profile: Profiles.collection.findOne({ userId: Meteor.userId() }),
    };
  }, [userId]);

  return (
    <Navbar expand="lg" className="site-navbar" sticky="top">
      <Container>
        <Navbar.Brand as={NavLink} to="/" className="brand-lockup">
          <MatchMark size={26} title="MatchBook" />
          <Wordmark />
        </Navbar.Brand>
        <Navbar.Toggle aria-controls="basic-navbar-nav" />
        <Navbar.Collapse id="basic-navbar-nav">
          <Nav className="me-auto nav-pill-group">
            {currentUser && <Nav.Link id="nav-discover" as={NavLink} to="/discover">Discover</Nav.Link>}
            {currentUser && <Nav.Link id="nav-match" as={NavLink} to="/discover-events">Match</Nav.Link>}
            {currentUser && <Nav.Link id="browse-clubs" as={NavLink} to="/search-clubs">Nearby</Nav.Link>}
            {currentUser && <Nav.Link id="nav-agenda" as={NavLink} to="/upcoming-events">Calendar</Nav.Link>}
            {currentUser && <Nav.Link id="my-clubs" as={NavLink} to="/saved">Saved</Nav.Link>}

            {currentUser && (
              <NavDropdown id="club-drop" title="Start something">
                <NavDropdown.Item id="add-clubs" as={NavLink} to="/create-club">Start a group</NavDropdown.Item>
                <NavDropdown.Item id="create-event" as={NavLink} to="/create-event">Start an event</NavDropdown.Item>
                <NavDropdown.Divider />
                <NavDropdown.Item id="event-finder" as={NavLink} to="/upcoming-events">All events</NavDropdown.Item>
                <NavDropdown.Item id="my-events" as={NavLink} to="/user-events">My events</NavDropdown.Item>
              </NavDropdown>
            )}

            {isAdmin && <Nav.Link as={NavLink} to="/admin">Organize</Nav.Link>}

            {!currentUser && (
              <>
                <Nav.Link as={NavLink} to="/upcoming-events">Discover</Nav.Link>
                <Nav.Link as={NavLink} to="/search-clubs">Nearby</Nav.Link>
                <Nav.Link as={NavLink} to="/create-club">For organizers</Nav.Link>
              </>
            )}
          </Nav>

          {!currentUser && (
            <Nav className="align-items-lg-center me-lg-3">
              <Nav.Link as={NavLink} to="/signin" className="btn btn-match">See what&apos;s nearby</Nav.Link>
            </Nav>
          )}
          <Nav className="align-items-lg-center">
            <NavDropdown
              title={currentUser ? (
                <span className="profile-menu-trigger">
                  <Image src={profileImagePath(profile?.picture)} alt="Profile" className="profilePicture" />
                  <span className="d-none d-xl-inline">{profile?.firstName || 'Profile'}</span>
                </span>
              ) : (
                <span className="profile-menu-trigger"><PersonCircle /> Sign In</span>
              )}
              id="nav-dropdown-profile"
              align="end"
            >
              {currentUser ? (
                <>
                  <NavDropdown.Item id="profile" as={NavLink} to="/profile">Profile</NavDropdown.Item>
                  <NavDropdown.Item id="nav-my-clubs" as={NavLink} to="/my-clubs">My Clubs</NavDropdown.Item>
                  <NavDropdown.Item id="nav-calendar-events" as={NavLink} to="/agenda">Agenda</NavDropdown.Item>
                  <NavDropdown.Item id="nav-customize" as={NavLink} to="/settings"><Gear /> Customize</NavDropdown.Item>
                  <NavDropdown.Divider />
                  <NavDropdown.Item id="navbar-current-user" as={NavLink} to="/signout">Logout</NavDropdown.Item>
                </>
              ) : (
                <>
                  <NavDropdown.Item id="nav-dropdown-profile-sign-in" as={NavLink} to="/signin">Sign In</NavDropdown.Item>
                  <NavDropdown.Item id="login-dropdown-sign-up" as={NavLink} to="/signup">Sign Up</NavDropdown.Item>
                </>
              )}
            </NavDropdown>
          </Nav>
        </Navbar.Collapse>
      </Container>
    </Navbar>
  );
};

export default NavBar;
