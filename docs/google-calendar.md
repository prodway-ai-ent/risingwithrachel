# Google Calendar

Session booking writes a row and sends a confirmation email, then asks Google Calendar to create a matching event. The sync runs only after the `rwr-google-calendar` secret in Secrets Manager holds real OAuth values. Until then the secret stores placeholders and each session is saved with calendar status `pending_credentials`.

Replace these fields in that secret. Leave the secret name as it is.

- `client_id`
- `client_secret`
- `refresh_token`
- `calendar_id` (use `primary` for Rachel's main calendar)

The refresh token has to be issued for the Google account whose calendar should show the sessions, with the Calendar scope. Placeholder values start with `dummy` and are ignored. A booking still succeeds when Google is not connected. Cancelling a session removes the Google event once those values are real and an event id was stored.
