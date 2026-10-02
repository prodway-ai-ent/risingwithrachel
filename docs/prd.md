# Product requirements

Rising with Rachel is the public coaching site and the private admin Rachel uses for inquiries, clients, and sessions. The site is https://risingwithrachel.com.

## Visitors

A visitor can read the marketing pages and send an inquiry. The inquiry is stored, and a notice goes to hello@risingwithrachel.com. That address is forwarded to Rachel.

## Admin

Rachel signs in at https://risingwithrachel.com/admin with her email, password, and an authenticator app. She can:

- Search inquiries and clients.
- Turn an inquiry into a client, and save notes on the client.
- Book a session for a client. Sessions are Monday through Friday, 9:00 AM to 5:00 PM Central, for 30, 45, 60, or 90 minutes, and cannot overlap another scheduled session.
- Cancel a session from the client profile.
- Export clients and sessions as a CSV file.

## Clients with a session

When email delivery allows it, the client receives a confirmation with one link. That link opens a page where the client can cancel the session or move it to another open time inside the same working hours. A reminder goes out about 24 hours before the session, and another about an hour before, each with the same link.

Amazon SES is still in the sandbox, so a message to an address that is not already verified is refused. The session is still saved.

## Calendar and payments

Google Calendar create, update, and delete run only after the `rwr-google-calendar` secret no longer holds placeholder values. Until then the admin shows that the session is waiting on Google Calendar credentials.

Stripe is not shown. Checkout is not offered. The webhook records a completed checkout or a refund only after the `rwr-stripe` secret holds live keys.

## Out of the current build

- A public page where a new client picks a service and books without Rachel.
- Package prices, a payment screen, and refunds in the admin.
- A live two-way Google Calendar connection. That waits on Rachel's Google account.
- Transfer of the GitHub repository to Rachel. The repository is prodway-ai-ent/risingwithrachel.

## Acceptance

| Check | Where it stands |
| --- | --- |
| Site served from AWS over HTTPS | Met |
| Book, reschedule, and cancel | Met for sessions Rachel books. The client uses the link in the email. |
| Google Calendar in both directions | Coded. Waiting on real credentials. |
| Confirmation and reminder email | Coded. Delivery waits on SES production access. |
| Payments in the admin | Hidden until live Stripe keys are saved. |
| Admin sign-in with MFA, clients, and sessions | Met for sign-in, client records, booking, cancel, and export. |
| Encrypted private database with backups | Met. See database restore. |
| Deploy through GitHub without long-lived AWS keys | Met |
| Logging, alarms, and a firewall | Met. There is no load balancer. The HTTP API and CloudFront are the edges. |
| Requirements, architecture, runbook, and admin guide | This set of documents. |
