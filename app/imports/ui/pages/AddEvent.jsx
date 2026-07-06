import React from 'react';
import { Card, Col, Container, Row } from 'react-bootstrap';
import { AutoForm, DateField, ErrorsField, LongTextField, NumField, SubmitField, TextField } from 'uniforms-bootstrap5';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import SimpleSchema2Bridge from 'uniforms-bridge-simple-schema-2';
import SimpleSchema from 'simpl-schema';

const formSchema = new SimpleSchema({
  eventID: SimpleSchema.Integer,
  title: String,
  description: { type: String, optional: true },
  date: Date,
  location: String,
  createdBy: { type: String, optional: true },
  image: { type: String, optional: true },
});

const bridge = new SimpleSchema2Bridge(formSchema);

const AddEvent = () => {
  let fRef = null;

  const submit = data => {
    Meteor.call('Events.insert', data, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Success', 'Event created successfully.', 'success');
        fRef.reset();
      }
    });
  };

  return (
    <Container id="add-events" className="page-shell py-5">
      <div className="page-intro">
        <h1>Start an event</h1>
      </div>
      <Row className="justify-content-center">
        <Col xs={12} lg={8} xl={7}>
          <Card className="form-card">
            <Card.Body>
              <AutoForm ref={ref => { fRef = ref; }} schema={bridge} onSubmit={data => submit(data)}>
                <Row>
                  <Col md={5}><NumField id="eventID" name="eventID" label="Host club #" /></Col>
                  <Col md={7}><TextField id="title" name="title" label="Title" /></Col>
                </Row>
                <TextField id="image" name="image" label="Image URL" placeholder="/images/codingWorkshop.png" />
                <TextField id="location" name="location" label="Location" />
                <LongTextField id="description" name="description" label="Description" />
                <DateField id="date" name="date" label="Date" />
                <TextField id="createdBy" name="createdBy" label="Created by" placeholder="you@hawaii.edu" />
                <SubmitField id="submit" value="Create event" className="btn-solid-primary" />
                <ErrorsField />
              </AutoForm>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default AddEvent;
