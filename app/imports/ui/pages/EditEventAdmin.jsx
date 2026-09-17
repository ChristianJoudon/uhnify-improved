import React, { useEffect, useRef, useState } from 'react';
import { Container } from 'react-bootstrap';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { Link, useParams } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { Roles } from 'meteor/alanning:roles';
import { Camera, Trash } from 'react-bootstrap-icons';
import PageHead from '../components/PageHead';
import PosterArt from '../components/PosterArt';
import LoadingSpinner from '../components/LoadingSpinner';
import { Events } from '../../api/events/Events';
import { Clubs } from '../../api/club/Club';
import { formatEventDate, isPhoto } from '../utilities/helpers';
import { shrinkImage } from '../utilities/shrinkImage';
import { topicForEvent } from '../utilities/topics';
import { TEXT_LIMITS } from '../../api/listing/limits';

/**
 * `datetime-local` wants wall-clock time. toISOString would hand it UTC, which
 * moves every event by the offset each time the form is opened and saved.
 */
const toLocalInput = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * The same screen as Start an event, pointed at an event that already exists —
 * live poster, real host list, one date control. It was the last AutoForm in
 * the app, which meant creating and editing the same object looked like two
 * unrelated products.
 *
 * The host is picked by name here as it is on Start an event, but the stored
 * numeric club id is what travels: an event whose host has since been deleted
 * keeps its number rather than being silently reassigned.
 */
const EditEventAdmin = () => {
  const { _id } = useParams();
  const fileInput = useRef(null);
  const seededFor = useRef(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const { doc, clubs, isAdmin, ready } = useTracker(() => {
    // An administrator, or whoever posted it: see EditClubAdmin.
    const eventSub = Meteor.subscribe(Events.adminPublicationName);
    const ownedSub = Meteor.subscribe('Events.publication.owned');
    const clubSub = Meteor.subscribe(Clubs.userPublicationName);
    const found = Events.collection.findOne(_id);
    return {
      doc: found?.owner ? found : null,
      isAdmin: Roles.userIsInRole(Meteor.userId(), 'admin'),
      clubs: Clubs.collection.find({}, { sort: { name: 1 } }).fetch(),
      ready: eventSub.ready() && ownedSub.ready() && clubSub.ready(),
    };
  }, [_id]);

  // Seeded once per event, not on every doc change: the subscription is live,
  // so re-seeding would wipe whatever is half-typed the moment the save echoes
  // back. Keyed on the route id, because React keeps this component mounted
  // when one edit route replaces another.
  useEffect(() => {
    if (doc && seededFor.current !== _id) {
      seededFor.current = _id;
      setForm({
        title: doc.title || '',
        // Held as text because that is what a <select> value is; it becomes a
        // number again on the way out.
        eventID: doc.eventID === undefined ? '' : String(doc.eventID),
        date: toLocalInput(doc.date),
        location: doc.location || '',
        description: doc.description || '',
        email: doc.email || '',
        image: doc.image || '',
      });
    }
  }, [doc, _id]);

  if (!ready) {
    return <LoadingSpinner />;
  }

  // "Not there" is not "not loaded yet". Once the subscription is ready and the
  // record still is not, this used to sit on the spinner forever — an admin who
  // deletes something and then opens an old edit link saw a hung page.
  if (!doc) {
    return (
      <Container id="edit-missing" className="page-shell py-4">
        <div className="mb-empty">
          <h3>That event is not here any more.</h3>
          <p>It may have been deleted since this link was made.</p>
          <Link className="btn btn-solid-primary" to="/admin">Back to the dashboard</Link>
        </div>
      </Container>
    );
  }

  // One frame where the record has arrived but the effect that seeds `form` has
  // not run yet; reading form.* here would throw.
  if (!form || seededFor.current !== _id) {
    return <LoadingSpinner />;
  }

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  const host = clubs.find(club => String(club.clubID) === form.eventID);
  // Events.update stores the selected host's categories on the event. Resolve
  // that exact prospective record so this preview cannot disagree with the
  // public poster after Save.
  const topic = topicForEvent({
    title: form.title,
    description: form.description,
    categories: host?.categories,
  });
  const when = form.date ? formatEventDate(new Date(form.date)) : '';
  // Only a genuinely uploaded photo becomes the poster face; the seeded stock
  // art is not this app's design and the event poster already ignores it.
  const photo = isPhoto(form.image) ? form.image : '';
  const valid = form.title.trim() && form.eventID && form.date && form.location.trim();

  const pickImage = async event => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear it, or picking the same file after Remove fires no change event.
    // Held as a local first: assigning straight through `event.target` trips
    // no-param-reassign, a rule that exists to stop a handler mutating its
    // caller's data — and this is a deliberate write to a DOM node, not that.
    input.value = '';
    if (!file) {
      return;
    }
    try {
      // Shrunk here rather than refused: a phone photo is several megabytes,
      // and the 2 MB door that stood here turned real people away.
      set('image', await shrinkImage(file));
    } catch (error) {
      swal('Could not use that photo', error.message, 'error');
    }
  };

  const submit = event => {
    event.preventDefault();
    if (!valid || saving) {
      return;
    }
    setSaving(true);
    // The payload is built key by key: the method's check() pattern rejects
    // anything it did not ask for, including _id and owner.
    Meteor.call('Events.update', _id, {
      eventID: Number.parseInt(form.eventID, 10),
      title: form.title.trim(),
      description: form.description.trim(),
      date: new Date(form.date),
      location: form.location.trim(),
      // Blank takes the address down; the server unsets it.
      email: form.email.trim(),
      image: form.image,
    }, error => {
      setSaving(false);
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Saved', 'That event is up to date.', 'success');
      }
    });
  };

  return (
    <Container id="edit-event" className="page-shell py-4">
      <PageHead
        title="Edit event"
        eyebrow="Admin"
        action={<Link className="btn btn-soft-primary" to={isAdmin ? '/admin' : `/manage/event/${_id}`}>{isAdmin ? 'All events' : 'Back'}</Link>}
      >
        Saved changes are live on the wall straight away.
      </PageHead>

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">Preview</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={when}
              title={form.title}
              tagline={form.description}
              image={photo}
              placeholder="This event"
            />
            <div className="mb-poster-foot">
              <span className="mb-poster-meta">
                {form.location || 'Where it happens'}
                <em>{host ? host.name : (topic.activityLabel || topic.label)}</em>
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
                maxLength={TEXT_LIMITS.title}
                onChange={e => set('title', e.target.value)}
                required
              />
            </label>

            <label htmlFor="eventID">
              Hosted by
              <select id="eventID" value={form.eventID} onChange={e => set('eventID', e.target.value)} required>
                {!host && (
                  <option value={form.eventID}>
                    {form.eventID ? `Group #${form.eventID} — no longer in the directory` : 'Choose a group…'}
                  </option>
                )}
                {clubs.map(club => (
                  <option key={club._id} value={String(club.clubID)}>{club.name}</option>
                ))}
              </select>
            </label>
            <span className="field-hint">The host decides which members see this on their agenda.</span>

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
                  maxLength={TEXT_LIMITS.location}
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
                rows={5}
                value={form.description}
                maxLength={TEXT_LIMITS.description}
                onChange={e => set('description', e.target.value)}
              />
            </label>
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
              <input ref={fileInput} type="file" accept="image/*" onChange={pickImage} className="d-none" />
            </div>
            <span className="field-hint">Only an uploaded photo becomes the poster face; without one it is drawn from the topic.</span>
          </section>

          <section className="form-block">
            <h3>Contact</h3>
            <label htmlFor="email">
              Contact email
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={form.email}
                maxLength={TEXT_LIMITS.email}
                placeholder="hello@yourgroup.org"
                onChange={e => set('email', e.target.value)}
                aria-describedby="email-hint"
              />
            </label>
            <span className="field-hint" id="email-hint">
              Optional — printed on the event&apos;s card for anyone to see. Clear it to take it down.
            </span>
            {/* Who posted a listing is a fact about the record, not a field.
                The editable "Posted by" box that stood here wrote a second
                copy of the poster's address, and that copy was the one the
                public publications did not withhold. This reads `owner`,
                which only the admin publication sends. */}
            {doc.owner && <p className="field-hint">Posted by {doc.owner}</p>}
          </section>

          <div className="create-actions">
            <button id="submit" type="submit" className="btn btn-solid-primary" disabled={!valid || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {!valid && <span className="field-hint">Name, host, when, and where.</span>}
          </div>
        </form>
      </div>
    </Container>
  );
};

export default EditEventAdmin;
