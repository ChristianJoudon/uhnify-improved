import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Accounts } from 'meteor/accounts-base';
import { Container } from 'react-bootstrap';
import PageHead from '../components/PageHead';

/** Where the confirmation mail's link lands. */
const VerifyEmail = () => {
  const { token } = useParams();
  const [state, setState] = useState('checking');

  useEffect(() => {
    Accounts.verifyEmail(token, error => setState(error ? 'failed' : 'verified'));
  }, [token]);

  return (
    <Container id="verify-email" className="page-shell py-4">
      <div className="auth-shell">
        {state === 'checking' && <PageHead title="One moment…" />}
        {state === 'verified' && (
          <>
            <PageHead title="That's your address.">You can post groups and events now.</PageHead>
            <p className="auth-alt"><Link className="btn btn-solid-primary" to="/">Take me in</Link></p>
          </>
        )}
        {state === 'failed' && (
          <>
            <PageHead title="That link didn't work.">It may have been used already, or it has expired.</PageHead>
            <p className="auth-alt">Sign in and ask for a new one from <Link to="/settings">Settings</Link>.</p>
          </>
        )}
      </div>
    </Container>
  );
};

export default VerifyEmail;
