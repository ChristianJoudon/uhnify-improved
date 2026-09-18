import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import PageHead from '../components/PageHead';

/**
 * The privacy policy and the terms, written from what the app actually does
 * rather than from a template, so that every sentence can be checked against
 * the code. When the code changes what it collects, this changes with it.
 *
 * The operator's name and address come from settings.public.operator, which
 * production must set (productionGuard warns when it is missing). Nothing here
 * is legal advice; it is an honest description, in plain words.
 */
const operator = () => Meteor.settings.public?.operator || {};
const site = () => Meteor.settings.public?.siteName || 'MatchBook';

const Contact = () => {
  const { name, email } = operator();
  if (!email) {
    return <p><em>The operator&apos;s contact address has not been set yet.</em></p>;
  }
  return <p>{site()} is run by {name || 'an individual'}. Write to <a href={`mailto:${email}`}>{email}</a>.</p>;
};

const Privacy = () => (
  <>
    <p>This is what {site()} keeps about you, why, and for how long. It is short because the app is small.</p>

    <h2>What you give us</h2>
    <ul>
      <li><strong>An email address and password</strong> to sign in. The password is stored hashed; we never see it.</li>
      <li><strong>A profile</strong> — a name, a line about you, a photo if you add one, and the topics you pick. Other signed-in members can see your name and photo in the people list so they can find you.</li>
      <li><strong>Listings you post</strong> — groups and events. They are public, under a display name, never your email. A contact email is printed on a listing only if you type one in.</li>
      <li><strong>Reports</strong> you send about a listing, read by an administrator.</li>
    </ul>

    <h2>What the app records as you use it</h2>
    <ul>
      <li>
        <strong>Your plans</strong> — the events you say you are going to and the groups you join. Friends see these
        only if you switch that on in Settings, and never for support, health, LGBTQ+ or faith listings.
      </li>
      <li>
        <strong>A made-up name</strong> (an animal and an adjective) shown in place of yours inside anonymous groups.
        Only an administrator can connect it to you.
      </li>
      <li>
        <strong>What you look at and swipe</strong>, to rank listings for you. This behaviour log is kept for 18 months and then deleted.
        You can turn recommendations off for everyone by contacting the operator; the log is never shared or sold.
      </li>
      <li>
        <strong>Your rough location</strong>, only when you allow it in your browser, to sort what is nearby.
        If you decline, the app falls back to a town-level guess from your network address made by ipapi.co, and never stores a precise position.
      </li>
      <li><strong>An audit trail</strong> of changes — who edited, joined, removed what — for 12 months, so that mistakes can be undone.</li>
    </ul>

    <h2>Who else is involved</h2>
    <ul>
      <li>Map tiles are drawn by CARTO; loading a map tells them your network address, as any web image does.</li>
      <li>Email (confirmation, password reset) is sent through a mail provider, which sees your address and the message.</li>
      <li>Errors and slow pages are reported to a monitoring service, without the contents of what you typed.</li>
    </ul>
    <p>Nothing is sold, and nothing is shared with anyone for advertising.</p>

    <h2>What you can do</h2>
    <ul>
      <li>Edit your profile, your topics and your sharing choice in Settings at any time.</li>
      <li><strong>Delete your account</strong> in Settings. Your profile, plans, friendships and history are erased at once. Listings you posted stay up for everyone else, with your name taken off them.</li>
      <li>Ask the operator for a copy of what is kept about you.</li>
    </ul>

    <h2>Who you are dealing with</h2>
    <Contact />
    <p>You must be 18 or older to have an account.</p>
  </>
);

const Terms = () => (
  <>
    <p>By signing up you agree to these. They are meant to be read.</p>
    <h2>Your account</h2>
    <ul>
      <li>You are 18 or older, and the email address is yours.</li>
      <li>One person, one account. Keep your password to yourself.</li>
    </ul>
    <h2>What you post</h2>
    <ul>
      <li>Post real things: groups that meet, events that happen. Say who is hosting only if it is true.</li>
      <li>No spam, no adverts dressed as events, nothing hateful, nothing that endangers anybody.</li>
      <li>You keep the rights to what you write and upload, and you let {site()} show it to its members and visitors.</li>
      <li>Anyone can report a listing. An administrator can take a listing down, and can suspend an account that keeps breaking these rules. The reason is shown to the person it happened to.</li>
    </ul>
    <h2>Groups and privacy</h2>
    <ul>
      <li>Whoever runs a group decides whether it is private, whether it approves new members, and whether it is anonymous. Respect those settings: what you learn inside an anonymous group stays there.</li>
    </ul>
    <h2>What we cannot promise</h2>
    <ul>
      <li>Listings come from many places and change. Check the time and the place before you go; {site()} is not responsible for an event that moved, filled up or was cancelled.</li>
      <li>The service is offered as it is, may be unavailable at times, and may change or end.</li>
    </ul>
    <h2>Contact</h2>
    <Contact />
    <p>See also the <Link to="/privacy">privacy policy</Link>.</p>
  </>
);

const LegalPage = ({ which }) => (
  <Container className="page-shell py-4 legal-page">
    <PageHead title={which === 'privacy' ? 'Privacy' : 'Terms'} eyebrow={site()} />
    {which === 'privacy' ? <Privacy /> : <Terms />}
  </Container>
);

LegalPage.propTypes = {
  which: PropTypes.oneOf(['privacy', 'terms']).isRequired,
};

export default LegalPage;
