// Start the app.
import '../imports/startup/client/Startup';

// Load method definitions on the client too, so Meteor runs them as stubs
// (latency compensation): writes appear in minimongo instantly instead of
// waiting for the server round-trip.
import '../imports/startup/both/Methods';

// Import Bootstrap css.
import 'bootstrap/dist/css/bootstrap.min.css';

// Override default Bootstrap styles.
import './style.css';
