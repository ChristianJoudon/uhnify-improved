import React, { useEffect, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { EnvelopeOpen, Link45deg } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import { joinGroupAndTell } from '../utilities/joinGroup';

/**
 * Where an invite link lands: "you have been asked into this — join?"
 *
 * A private group is in no list the holder of a link can reach, so everything
 * on this page comes from one method, 'clubs.inviteInfo', and that method says
 * deliberately little: the name, how many people are in it, and whether it is
 * anonymous. The rest is what joining shows.
 *
 * The token is read from the address and handed to two method calls. It is
 * never drawn, stored, or put into another address — it is a capability, and
 * the only copies should be the one the owner sent and the one in this bar.
 *
 * There is no "already a member" branch. Joining a group one is in changes
 * nothing and answers 'joined', so the button does the right thing either way
 * and the person ends up where they wanted to be: on their groups, with this
 * one among them.
 */
const JoinGroup = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  // undefined while asking; null once the link is known to be dead.
  const [invite, setInvite] = useState(undefined);
  // A failure that is not the link's fault — the rate limit, a dropped
  // connection. Saying "this link does not work" for those would send the
  // person back to the owner for a new link they do not need.
  const [trouble, setTrouble] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let active = true;
    setInvite(undefined);
    setTrouble('');
    Meteor.call('clubs.inviteInfo', token, (error, result) => {
      if (!active) {
        return;
      }
      if (error && error.error !== 'not-found') {
        setTrouble(error.reason || error.message);
      }
      setInvite(error ? null : result);
    });
    return () => {
      active = false;
    };
  }, [token]);

  // The link usually joins outright, but not always. Between this page asking
  // about the token and the button being pressed, the owner can have made a
  // new link; on a group that asks first the server then takes a REQUEST, and
  // answers with one. This read only the error, so that person was sent to My
  // groups with no group there and not a word about why. joinGroupAndTell says
  // which of the two happened, and says a refusal too, resolving with nothing.
  const join = () => {
    setJoining(true);
    joinGroupAndTell(invite.clubId, { inviteToken: token }).then(result => {
      if (result) {
        navigate('/saved', { replace: true });
      } else {
        setJoining(false);
      }
    });
  };

  if (invite === undefined) {
    return <LoadingSpinner />;
  }

  if (!invite) {
    return (
      <Container id="join-group" className="page-shell page-notice py-5">
        <PageHead title="Invitation" />
        <div className="mb-empty">
          <Link45deg className="mb-empty-glyph" aria-hidden="true" />
          <h3>{trouble ? 'We could not open that just now.' : 'This link does not work any more.'}</h3>
          <p>
            {trouble || 'The person who runs the group may have made a new one. Ask them to send it to you.'}
          </p>
          <Link className="btn btn-solid-primary" to="/search-clubs">Find groups</Link>
        </div>
      </Container>
    );
  }

  const members = `${invite.memberCount} ${invite.memberCount === 1 ? 'member' : 'members'}`;

  return (
    <Container id="join-group" className="page-shell page-notice py-5">
      <PageHead title="You're invited" />
      <div className="mb-panel join-invite">
        <EnvelopeOpen className="mb-empty-glyph" aria-hidden="true" />
        <h2 className="join-invite-name">{invite.name}</h2>
        {(invite.memberCount > 0 || invite.anonymous) && (
          <p className="join-invite-facts">
            {invite.memberCount > 0 && <span>{members}</span>}
            {invite.anonymous && (
              <span className="mb-chip mb-chip--sm mb-chip--static">Anonymous</span>
            )}
          </p>
        )}
        {/* Said before the button, because for the groups this exists for it is
            what decides whether the button gets pressed. "While", because that
            is as far as the promise goes for a group that is anonymous by its
            owner's choice: they can switch it off, and the server then shows
            them the list. A support or health group cannot be switched, but
            'clubs.inviteInfo' does not say which kind this is, so the sentence
            is the one that is true of both. */}
        {invite.anonymous && (
          <p>While this group is anonymous, nobody can see who is in it — not other members, and not the person who runs it.</p>
        )}
        <button type="button" className="btn btn-match" onClick={join} disabled={joining}>
          {joining ? 'Joining…' : 'Join'}
        </button>
      </div>
    </Container>
  );
};

export default JoinGroup;
