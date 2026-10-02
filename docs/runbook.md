# Runbook

Account `794934876529`, region `us-east-1`, AWS CLI profile `rachel`. The GitHub repository is prodway-ai-ent/risingwithrachel.

## Deploy the site

Push to `main`. The Deploy workflow builds the app and publishes `build/` to S3 bucket `rwr-site-794934876529`, then invalidates CloudFront distribution `E203DSZKL8HMTK`. It does not change Lambda code, the database, or secrets.

## Deploy a Lambda

From a checkout of the commit you want to run:

```bash
zip -j /tmp/rwr-admin.zip backend/admin/index.mjs
aws lambda update-function-code --function-name rwr-admin --region us-east-1 --zip-file fileb:///tmp/rwr-admin.zip
```

Use `backend/intake/index.mjs` and function `rwr-intake` for the inquiry handler. Keep the existing environment variables. `rwr-admin` needs `CLUSTER_ARN`, `SECRET_ARN`, `DB_NAME`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `GOOGLE_CALENDAR_SECRET_ARN`, `STRIPE_SECRET_ARN`, `FROM_ADDRESS`, and `NOTIFY_ADDRESS`.

Schema changes go through `backend/migrations/apply.mjs` with `CLUSTER_ARN`, `SECRET_ARN`, and `AWS_REGION=us-east-1`. The runner records applied file names in `schema_migrations` and skips them on the next run.

## Roll back the site

Revert the commit on `main` and push. The workflow publishes the previous build. To roll back a Lambda, zip the previous `index.mjs` from git and run the update command above.

## Restore the database

Follow [database-restore.md](database-restore.md). Do not delete `rwr-db` or `rwr-db-enc` until a restored cluster has been checked.

## Alarms

Topic `rwr-alerts` emails hello@risingwithrachel.com, which is forwarded to Rachel. The subscription has to be confirmed from that message before any alarm is delivered.

These alarms notify that topic. Missing data does not alarm.

- `rwr-admin-errors`, `rwr-intake-errors`, `rwr-forwarder-errors`: one or more Lambda errors in five minutes.
- `rwr-api-5xx`: one or more HTTP API 5xx responses in five minutes. API id `1wuql85ad1`.
- `rwr-api-latency`: p95 latency over 15 seconds for two periods in a row. The database pauses when idle, so a single slow wake-up does not page.
- `rwr-reminder-failures`: the EventBridge rule `rwr-session-reminders` failed to invoke.

Lambda logs are `/aws/lambda/rwr-admin`, `/aws/lambda/rwr-intake`, and `/aws/lambda/rwr-forwarder`, kept for 30 days.

## Firewall

Web ACL `rwr-cloudfront` is attached to CloudFront distribution `E203DSZKL8HMTK`. Sampled requests are in WAF, scope CloudFront, region us-east-1. To detach it, clear `WebACLId` on the distribution. Do that only when the ACL is blocking real visitors.

## Credentials

Admin sign-in is the Cognito user `rachelmlamm@gmail.com` in pool `rwr-admin`. The current password and authenticator secret are in Secrets Manager `rwr-admin-login`. To rotate the password, set a new one in Cognito and store the same value in that secret. Do not put the password in git or in a ticket.

Google Calendar starts working when `rwr-google-calendar` is updated with a real client id, client secret, refresh token, and calendar id. See [google-calendar.md](google-calendar.md).

Stripe stays hidden until `rwr-stripe` is updated with a live secret key, publishable key, and webhook secret. See [stripe.md](stripe.md).

The database password is the Aurora managed secret named in `SECRET_ARN`. Rotating it is the RDS managed-password rotation. Point `SECRET_ARN` at the new secret if the ARN changes, on both `rwr-intake` and `rwr-admin`.

## Mail

SES is in the sandbox. Confirmation and reminder messages to a normal client address fail until production access is turned on. Domain risingwithrachel.com and rachelmlamm@gmail.com are verified. The from address is hello@risingwithrachel.com.
