import React, { useMemo, useRef, useState } from 'react';
import { Button, Card, Col, Container, Form, Image, Row } from 'react-bootstrap';
import { useTracker } from 'meteor/react-meteor-data';
import { AutoForm, ErrorsField, LongTextField, SubmitField, TextField } from 'uniforms-bootstrap5';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import SimpleSchema2Bridge from 'uniforms-bridge-simple-schema-2';
import SimpleSchema from 'simpl-schema';
import { Camera } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import { Profiles } from '../../api/profiles/Profiles';
import { categoriesToText, normalizeCategories, profileImagePath } from '../utilities/helpers';

const formSchema = new SimpleSchema({
  firstName: String,
  lastName: String,
  email: String,
  bio: String,
  title: String,
  interests: { type: String, optional: true },
});

const bridge = new SimpleSchema2Bridge(formSchema);

const Profile = () => {
  const [imagePreview, setImagePreview] = useState('');
  const fileInput = useRef(null);

  const { ready, profile } = useTracker(() => {
    const subscription = Meteor.subscribe(Profiles.userPublicationName);
    return {
      ready: subscription.ready(),
      profile: Profiles.collection.findOne({ userId: Meteor.userId() }),
    };
  }, []);

  const model = useMemo(() => {
    if (!profile) {
      return {};
    }
    return {
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      email: profile.email || '',
      bio: profile.bio || '',
      title: profile.title || '',
      interests: categoriesToText(profile.interests),
    };
  }, [profile]);

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
        } else {
          swal('Updated', 'Profile picture updated.', 'success');
        }
      });
    };
    reader.readAsDataURL(file);
  };

  const submit = data => {
    Meteor.call('Profiles.update', { ...data, interests: normalizeCategories(data.interests) }, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Success', 'Profile updated successfully.', 'success');
      }
    });
  };

  if (!ready || !profile) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="settings-page" className="page-shell py-5">
      <div className="page-intro">
        <h1>Customize</h1>
      </div>
      <Row className="justify-content-center g-4">
        <Col lg={4}>
          <Card className="profile-side-card h-100">
            <Card.Body className="text-center">
              <Image src={imagePreview || profileImagePath(profile.picture)} alt="Profile" className="profile-avatar-xl" />
              <h3 className="mt-4 mb-1">{profile.firstName || 'Student'} {profile.lastName || ''}</h3>
              <p className="profile-bio-text">{profile.title || 'Student'}</p>
              <Button type="button" className="btn-soft-primary mt-3" onClick={() => fileInput.current.click()}>
                <Camera /> Edit photo
              </Button>
              <Form.Control ref={fileInput} type="file" accept="image/*" onChange={handleImageChange} className="d-none" />
            </Card.Body>
          </Card>
        </Col>
        <Col lg={8}>
          <Card className="form-card">
            <Card.Body>
              <AutoForm schema={bridge} onSubmit={data => submit(data)} model={model}>
                <Row>
                  <Col md={6}><TextField name="firstName" label="First Name" /></Col>
                  <Col md={6}><TextField name="lastName" label="Last Name" /></Col>
                </Row>
                <TextField name="email" label="Email" />
                <TextField name="title" label="Title" />
                <LongTextField name="bio" label="Bio" />
                <TextField name="interests" label="Interests" placeholder="Technology, Service, Sports/Leisure" />
                <SubmitField value="Save" className="btn-solid-primary" />
                <ErrorsField />
              </AutoForm>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default Profile;
