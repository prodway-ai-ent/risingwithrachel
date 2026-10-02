# Stripe

Payments stay off until the `rwr-stripe` secret holds live keys. The admin does not show a payment screen, and booking does not send anyone to checkout.

The webhook is `POST /api/stripe/webhook`. While `secret_key`, `publishable_key`, or `webhook_secret` still start with `dummy`, that route responds as if it is not there. After the three values are replaced, the same route checks the Stripe signature and stores `checkout.session.completed` and `charge.refunded` events in the `payments` table.

Replace the values in Secrets Manager. Leave the secret name as it is.
