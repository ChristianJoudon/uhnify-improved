import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Container, Form, Image } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { Camera } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import { Profiles } from '../../api/profiles/Profiles';
import { normalizeCategories, profileImagePath } from '../utilities/helpers';
import { TOPICS, TOPIC_KEYS, topicFor } from '../utilities/topics';

const Settings = () => {
  const [imagePreview, setImagePreview] = useState('');
  const [form, setForm] = useState(null);
  const fileInput = useRef(null);

  const { ready, profile } = useTracker(() => {
    const subscription = Meteor.subscribe(Profiles.userPublicationName);
    return {
      ready: subscription.ready(),
      profile: Profiles.collection.findOne({ userId: Meteor.userId() }),
    };
  }, []);

  // Seed the editable copy once the profile arrives; never clobber in-progress edits.
  useEffect(() => {
    if (profile && !form) {
      setForm({
        firstName: profile.firstName || '',
        lastName: profile.lastName || '',
        email: profile.email || '',
        title: profile.title || '',
        bio: profile.bio || '',
        interests: normalizeCategories(profile.interests),
      });
    }
  }, [profile, form]);

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  const toggleInterest = label => setForm(current => ({
    ...current,
    interests: current.interests.includes(label)
      ? current.interests.filter(item => item !== label)
      : [...current.interests, label],
  }));

  const headerTopic = useMemo(
    () => topicFor(form?.interests || [], form?.title || ''),
    [form],
  );

  const handleImageChange = event => {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith('image')) {
      swal('Invalid file', 'Please choose an image file.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target.result;
      setImagePreview(result);
      Meteor.call('Profiles.updatePicture', result, error => {
        if (error) {
          swal('Error', error.reason || error.message, 'error');
        }
      });
    };
    reader.readAsDataURL(file);
  };

  const submit = event => {
    event.preventDefault();
    Meteor.call('Profiles.update', {
      firstName: form.firstName,
      lastName: form.lastName,
      email: form.email,
      title: form.title,
      bio: form.bio,
      interests: form.interests,
    }, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Saved', 'Your profile is up to date.', 'success');
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  if (!profile) {
    return (
      <Container id="customize-missing" className="page-shell py-4">
        <div className="mb-empty">
          <h3>We could not find your profile.</h3>
          <p>Sign out and back in — if it keeps happening, that is ours to fix, not yours.</p>
          <Link to="/signout" className="btn btn-solid-primary">Sign out</Link>
        </div>
      </Container>
    );
  }

  if (!form) {
    return <LoadingSpinner />;
  }

  const fullName = `${form.firstName} ${form.lastName}`.trim() || 'Your name';

  return (
    <Container id="settings-page" className="page-shell py-4">
      <div className="page-intro">
        <h1>Customize</h1>
        <p>This is what people see when they find you.</p>
      </div>

      <div className="customize-layout">
        {/* Live preview — the same card language the rest of the app uses, so
            the edits read as changes to a real thing rather than form values. */}
        <aside className="customize-preview">
          <div className="preview-card">
            <div className="preview-banner" style={{ background: headerTopic.field, color: headerTopic.ink }}>
              {/* The real drawing at full strength, so the preview is made of
                  the same parts the profile it previews is made of. */}
              <img className="preview-banner-art" src={headerTopic.icon} alt="" />
            </div>
            <div className="preview-body">
              <Image src={imagePreview || profileImagePath(profile.picture)} alt="" className="preview-avatar" />
              <h2>{fullName}</h2>
              <p className="preview-title">{form.title || 'Add a title'}</p>
              {form.bio && <p className="preview-bio">{form.bio}</p>}
              <div className="preview-chips">
                {form.interests.length === 0
                  ? <span className="preview-empty">No interests picked yet</span>
                  : form.interests.map(interest => {
                    const topic = topicFor(interest);
                    return (
                      <span key={interest} className="topic-chip" style={{ background: topic.chip, color: topic.chipInk }}>
                        {interest}
                      </span>
                    );
                  })}
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-soft-primary w-100 mt-3" onClick={() => fileInput.current.click()}>
            <Camera /> Change photo
          </button>
          <Form.Control ref={fileInput} type="file" accept="image/*" onChange={handleImageChange} className="d-none" />
        </aside>

        <form className="customize-form" onSubmit={submit}>
          <section className="form-block">
            <h3>You</h3>
            <div className="field-row">
              <label htmlFor="cz-first">
                First name
                <input id="cz-first" type="text" value={form.firstName} onChange={e => set('firstName', e.target.value)} required />
              </label>
              <label htmlFor="cz-last">
                Last name
                <input id="cz-last" type="text" value={form.lastName} onChange={e => set('lastName', e.target.value)} required />
              </label>
            </div>
            <label htmlFor="cz-title">
              Title
              <input id="cz-title" type="text" value={form.title} placeholder="Designer, student, organiser…" onChange={e => set('title', e.target.value)} />
            </label>
            <label htmlFor="cz-email">
              Email
              <input id="cz-email" type="email" value={form.email} onChange={e => set('email', e.target.value)} required />
            </label>
          </section>

          <section className="form-block">
            <h3>About</h3>
            <label htmlFor="cz-bio">
              A line or two about you
              <textarea id="cz-bio" rows={3} value={form.bio} onChange={e => set('bio', e.target.value)} />
            </label>
          </section>

          <section className="form-block">
            <h3>Interests</h3>
            {/* Interests are the same topics the finder sizes and colours cards
                by, so picking one here visibly changes what gets surfaced. */}
            <p className="form-note">Pick a few. They decide what the walls put in front of you first.</p>
            <div className="topic-picker">
              {TOPIC_KEYS.map(key => {
                const topic = TOPICS[key];
                const on = form.interests.includes(topic.label);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`topic-pick${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggleInterest(topic.label)}
                  >
                    {/* The one place in the app that asks you to weigh all
                        eight topics against each other, and it was eight bare
                        words. The drawings exist to make a topic recognisable
                        at a glance; this is where that matters most. */}
                    <span className="topic-pick-plate" style={{ background: topic.chip }}>
                      <img src={topic.icon} alt="" />
                    </span>
                    <span className="topic-pick-text">
                      <strong>{topic.label}</strong>
                      <small>{topic.tagline}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <button id="submit" type="submit" className="btn btn-solid-primary">Save changes</button>
        </form>
      </div>
    </Container>
  );
};

export default Settings;
