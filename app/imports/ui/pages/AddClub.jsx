import React from 'react';
import { Card, Col, Container, Row } from 'react-bootstrap';
import { AutoForm, ErrorsField, LongTextField, SubmitField, TextField } from 'uniforms-bootstrap5';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import SimpleSchema2Bridge from 'uniforms-bridge-simple-schema-2';
import SimpleSchema from 'simpl-schema';

const formSchema = new SimpleSchema({
  name: String,
  description: String,
  location: String,
  image: { type: String, optional: true },
  meetingTime: String,
  contactInfo: { type: String, optional: true },
  categories: { type: String, optional: true },
  tags: { type: String, optional: true },
});

const bridge = new SimpleSchema2Bridge(formSchema);

const AddClub = () => {
  let fRef = null;

  const submit = (data) => {
    const payload = { ...data, tags: (data.tags || '').split(',').map(tag => tag.trim()).filter(Boolean) };
    Meteor.call('Clubs.insert', payload, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Success', 'Club created successfully.', 'success');
        fRef.reset();
      }
    });
  };

  return (
    <Container id="add-clubs" className="page-shell py-5">
      <div className="page-intro">
        <h1>Start a club</h1>
      </div>
      <Row className="justify-content-center">
        <Col xs={12} lg={8} xl={7}>
          <Card className="form-card">
            <Card.Body>
              <AutoForm ref={ref => { fRef = ref; }} schema={bridge} onSubmit={data => submit(data)}>
                <Row>
                  <Col md={6}><TextField id="name" name="name" label="Name" /></Col>
                  <Col md={6}><TextField id="meetingTime" name="meetingTime" label="Meeting time" placeholder="Every Wednesday at 4 PM" /></Col>
                </Row>
                <TextField id="location" name="location" label="Location" />
                <TextField id="image" name="image" label="Image URL" placeholder="/images/LogoCircle.png" />
                <TextField id="contactInfo" name="contactInfo" label="Contact" placeholder="club@hawaii.edu" />
                <LongTextField id="description" name="description" label="Description" />
                <TextField id="categories" name="categories" label="Categories" placeholder="Academic/Professional, Service, Sports/Leisure" />
                <TextField id="tags" name="tags" label="Tags" placeholder="board games, hiking, K-pop" />
                <SubmitField id="submit" value="Create club" className="btn-solid-primary" />
                <ErrorsField />
              </AutoForm>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default AddClub;
