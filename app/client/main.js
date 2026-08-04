// Start the app.
import '../imports/startup/client/Startup';

// Load method definitions on the client too, so Meteor runs them as stubs
// (latency compensation): writes appear in minimongo instantly instead of
// waiting for the server round-trip.
import '../imports/startup/both/Methods';

// The audit collection, so an administrator's screen has somewhere to receive
// the trail. Defining it here does not publish anything — the publication is
// admin-only and capped — but without a client-side collection of the same name
// the published documents arrive with nowhere to go, and the trail reads as
// empty when it is in fact being written.
import '../imports/api/audit/AuditLog';

// Import Bootstrap css.
import 'bootstrap/dist/css/bootstrap.min.css';

// Override default Bootstrap styles.
import './style.css';
