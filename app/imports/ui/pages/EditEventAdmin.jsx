import React from 'react';
import swal from 'sweetalert';
import { Card, Col, Container, Row } from 'react-bootstrap';
import { AutoForm, DateField, ErrorsField, LongTextField, NumField, SubmitField, TextField } from 'uniforms-bootstrap5';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import SimpleSchema2Bridge from 'uniforms-bridge-simple-schema-2';
import SimpleSchema from 'simpl-schema';
import { useParams } from 'react-router-dom';
import { Events } from '../../api/events/Events';
import LoadingSpinner from '../components/LoadingSpinner';

const formSchema = new SimpleSchema({
  eventID: SimpleSchema.Integer,
  title: String,
  description: { type: String, optional: true },
  date: Date,
  location: String,
  createdBy: String,
  image: { type: String, optional: true },
});

const bridge = new SimpleSchema2Bridge(formSchema);

const EditEventAdmin = () => {
  const { _id } = useParams();
  const { doc, ready } = useTracker(() => {
    const subscription = Meteor.subscribe(Events.adminPublicationName);
    return {
      doc: Events.collection.findOne(_id),
      ready: subscription.ready(),
    };
  }, [_id]);

  const submit = data => {
    // Explicit payload: the AutoForm model includes _id/owner, which check() rejects.
    const payload = {
      eventID: data.eventID,
      title: data.title,
      description: data.description,
      date: data.date,
      location: data.location,
      createdBy: data.createdBy,
      image: data.image,
    };
    Meteor.call('Events.update', _id, payload, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Success', 'Event updated successfully.', 'success');
      }
    });
  };

  if (!ready || !doc) {
    return <LoadingSpinner />;
  }

  return (
    <Container className="page-shell py-5">
      <div className="page-intro">
        <h1>Edit event</h1>
      </div>
      <Row className="justify-content-center">
        <Col xs={12} lg={8} xl={7}>
          <Card className="form-card">
            <Card.Body>
              <AutoForm schema={bridge} onSubmit={data => submit(data)} model={doc}>
                <Row>
                  <Col md={5}><NumField id="eventID" name="eventID" label="Host Club ID" /></Col>
                  <Col md={7}><TextField id="title" name="title" /></Col>
                </Row>
                <TextField id="image" name="image" />
                <TextField id="location" name="location" />
                <LongTextField id="description" name="description" />
                <DateField id="date" name="date" />
                <TextField id="createdBy" name="createdBy" />
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

export default EditEventAdmin;
