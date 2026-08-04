import React, { useMemo, useRef, useState } from 'react';
import { Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { useNavigate } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { Camera, Trash } from 'react-bootstrap-icons';
import PosterArt from '../components/PosterArt';
import LoadingSpinner from '../components/LoadingSpinner';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { formatEventDate, normalizeCategories } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';

const TITLE_MAX = 80;
const ABOUT_MAX = 300;
const MAX_IMAGE_BYTES = 2000000;

const AddEvent = () => {
  const navigate = useNavigate();
  const fileInput = useRef(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '',
    hostId: '',
    date: '',
    location: '',
    description: '',
    image: '',
  });

  const { ready, myClubs, allClubs } = useTracker(() => {
    const clubsSub = Meteor.subscribe(Clubs.userPublicationName);
    const memberSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    const joinedIds = new Set(ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch().map(m => m.clubId));
    const clubs = Clubs.collection.find({}, { sort: { name: 1 } }).fetch();
    return {
      ready: clubsSub.ready() && memberSub.ready(),
      myClubs: clubs.filter(club => joinedIds.has(club._id)),
      allClubs: clubs,
    };
  }, []);

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  const host = useMemo(() => allClubs.find(club => club._id === form.hostId), [allClubs, form.hostId]);
  // Title first, host categories as the fallback — the exact order EventPoster
  // and SwipeCard use. Resolving it the other way here meant the preview
  // captioned "This is the card people swipe" showed a different colour and
  // motif than the card that actually got created.
  const topic = useMemo(
    () => topicFor(form.title, form.description, normalizeCategories(host?.categories), host?.tags),
    [host, form.title, form.description],
  );

  const when = form.date ? formatEventDate(new Date(form.date)) : '';
  const valid = form.title.trim() && form.hostId && form.date && form.location.trim();

  const pickImage = event => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image')) {
      swal('Not an image', 'Please choose an image file.', 'error');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      swal('Too large', 'Please choose an image under 2 MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => set('image', e.target.result);
    reader.readAsDataURL(file);
    // Held as a local first: assigning straight through `event.target` trips
    // no-param-reassign, a rule that exists to stop a handler mutating its
    // caller's data — and this is a deliberate write to a DOM node, not that.
    input.value = '';
  };

  const submit = event => {
    event.preventDefault();
    if (!valid || saving) {
      return;
    }
    setSaving(true);
    Meteor.call('Events.insert', {
      // The host is chosen from a list; the numeric id the schema wants is
      // looked up here rather than typed in by hand.
      eventID: host.clubID,
      title: form.title.trim(),
      description: form.description.trim(),
      date: new Date(form.date),
      location: form.location.trim(),
      // Empty string, never undefined — see AddClub.
      image: form.image,
    }, error => {
      setSaving(false);
      if (error) {
        swal('Could not create', error.reason || error.message, 'error');
      } else {
        swal('Created', `${form.title.trim()} is on the calendar.`, 'success').then(() => navigate('/upcoming-events'));
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  const hostOptions = myClubs.length > 0 ? myClubs : allClubs;

  return (
    <Container id="add-events" className="page-shell py-4">
      <div className="page-intro">
        <h1>Start an event</h1>
        <p>One-off happenings. For something recurring, start a group instead.</p>
      </div>

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">Preview</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={when}
              title={form.title}
              tagline={form.description}
              image={form.image}
              placeholder="Your event name"
            />
            <div className="mb-poster-foot">
              <span className="mb-poster-meta">
                {form.location || 'Where it happens'}
                <em>{host ? host.name : topic.label}</em>
              </span>
            </div>
          </div>
          <p className="field-hint mt-2">This is the card people swipe in Match.</p>
        </aside>

        <form className="create-form" onSubmit={submit}>
          <section className="form-block">
            <h3>The basics</h3>
            <label htmlFor="title">
              Name
              <input
                id="title"
                type="text"
                value={form.title}
                maxLength={TITLE_MAX}
                placeholder="Sunset Movie Night"
                onChange={e => set('title', e.target.value)}
                aria-describedby="title-count"
                required
              />
            </label>
            <span className="field-hint" id="title-count">{form.title.length}/{TITLE_MAX}</span>

            <label htmlFor="eventID">
              Hosted by
              <select id="eventID" value={form.hostId} onChange={e => set('hostId', e.target.value)} required>
                <option value="">Choose a group…</option>
                {hostOptions.map(club => (
                  <option key={club._id} value={club._id}>{club.name}</option>
                ))}
              </select>
            </label>
            <span className="field-hint">
              {myClubs.length > 0 ? 'Groups you belong to.' : 'Join a group and it will appear here first.'}
            </span>

            <div className="field-row">
              <label htmlFor="date">
                When
                <input
                  id="date"
                  type="datetime-local"
                  value={form.date}
                  onChange={e => set('date', e.target.value)}
                  required
                />
              </label>
              <label htmlFor="location">
                Where
                <input
                  id="location"
                  type="text"
                  value={form.location}
                  placeholder="Rooftop, 3rd floor"
                  onChange={e => set('location', e.target.value)}
                  required
                />
              </label>
            </div>
          </section>

          <section className="form-block">
            <h3>Details</h3>
            <label htmlFor="description">
              What to expect
              <textarea
                id="description"
                rows={3}
                value={form.description}
                maxLength={ABOUT_MAX}
                placeholder="What happens, what to bring, who it's for."
                onChange={e => set('description', e.target.value)}
                aria-describedby="about-count"
              />
            </label>
            <span className="field-hint" id="about-count">{form.description.length}/{ABOUT_MAX}</span>
          </section>

          <section className="form-block">
            <h3>Photo</h3>
            <div className="photo-row">
              <button type="button" className="btn btn-soft-primary" onClick={() => fileInput.current.click()}>
                <Camera /> {form.image ? 'Replace photo' : 'Add a photo'}
              </button>
              {form.image && (
                <button type="button" className="btn btn-outline-danger-soft" onClick={() => set('image', '')}>
                  <Trash /> Remove
                </button>
              )}
              <Form.Control ref={fileInput} type="file" accept="image/*" onChange={pickImage} className="d-none" />
            </div>
            <span className="field-hint">Optional — without one we design a poster from the host&apos;s topic.</span>
          </section>

          <div className="create-actions">
            <button id="submit" type="submit" className="btn btn-solid-primary" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create event'}
            </button>
            {!valid && <span className="field-hint">Name, host, when, and where.</span>}
          </div>
        </form>
      </div>
    </Container>
  );
};

export default AddEvent;
