import React from 'react';
import swal from 'sweetalert';
import { Card, Col, Container, Row } from 'react-bootstrap';
import { AutoForm, ErrorsField, LongTextField, NumField, SubmitField, TextField } from 'uniforms-bootstrap5';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import SimpleSchema2Bridge from 'uniforms-bridge-simple-schema-2';
import SimpleSchema from 'simpl-schema';
import { useParams } from 'react-router-dom';
import { Clubs } from '../../api/club/Club';
import LoadingSpinner from '../components/LoadingSpinner';
import { categoriesToText } from '../utilities/helpers';

const formSchema = new SimpleSchema({
  clubID: SimpleSchema.Integer,
  name: String,
  owner: String,
  description: String,
  location: String,
  image: { type: String, optional: true },
  meetingTime: String,
  contactInfo: { type: String, optional: true },
  categories: { type: String, optional: true },
  tags: { type: String, optional: true },
});

const bridge = new SimpleSchema2Bridge(formSchema);

const EditClubAdmin = () => {
  const { _id } = useParams();
  const { doc, ready } = useTracker(() => {
    const subscription = Meteor.subscribe(Clubs.adminPublicationName);
    return {
      doc: Clubs.collection.findOne(_id),
      ready: subscription.ready(),
    };
  }, [_id]);

  const submit = data => {
    // Build the payload explicitly: the AutoForm model carries _id/schedule and
    // other unknown keys that the method's check() pattern rightly rejects.
    const payload = {
      clubID: data.clubID,
      name: data.name,
      owner: data.owner,
      description: data.description,
      location: data.location,
      image: data.image,
      meetingTime: data.meetingTime,
      contactInfo: data.contactInfo,
      categories: data.categories,
      tags: (data.tags || '').split(',').map(tag => tag.trim()).filter(Boolean),
    };
    Meteor.call('Clubs.update', _id, payload, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Success', 'Club updated successfully.', 'success');
      }
    });
  };

  if (!ready || !doc) {
    return <LoadingSpinner />;
  }

  const model = { ...doc, categories: categoriesToText(doc.categories), tags: (doc.tags || []).join(', ') };

  return (
    <Container className="page-shell py-5">
      <div className="page-intro">
        <h1>Edit club</h1>
      </div>
      <Row className="justify-content-center">
        <Col xs={12} lg={8} xl={7}>
          <Card className="form-card">
            <Card.Body>
              <AutoForm schema={bridge} onSubmit={data => submit(data)} model={model}>
                <Row>
                  <Col md={4}><NumField id="clubID" name="clubID" disabled /></Col>
                  <Col md={8}><TextField id="name" name="name" /></Col>
                </Row>
                <TextField id="owner" name="owner" />
                <TextField id="location" name="location" />
                <TextField id="image" name="image" />
                <TextField id="meetingTime" name="meetingTime" />
                <TextField id="contactInfo" name="contactInfo" />
                <LongTextField id="description" name="description" />
                <TextField id="categories" name="categories" label="Categories" />
                <TextField id="tags" name="tags" label="Tags" placeholder="board games, hiking" />
                <SubmitField id="submit" value="Save" className="btn-solid-primary" />
                <ErrorsField />
              </AutoForm>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default EditClubAdmin;
