# Database restore

The intake and admin Lambdas use Aurora PostgreSQL `rwr-db-enc` in account `794934876529` (`us-east-1`) through the RDS Data API. The cluster is encrypted with the AWS-managed `alias/aws/rds` key, is not publicly accessible, keeps 7 days of automated backups, and has deletion protection on.

`rwr-intake` and `rwr-admin` read `CLUSTER_ARN` and `SECRET_ARN`. The secret is the cluster's managed master-user secret. The Lambda role `rwr-api-lambda-role` may call the Data API only on `rwr-db` and `rwr-db-enc`.

The previous cluster, `rwr-db`, is still present and unencrypted. The app no longer uses it. Aurora cannot turn encryption on for an existing cluster, and copying its snapshot with a KMS key is rejected, so `rwr-db-enc` was created new and the `submissions` rows were copied. Snapshot `rwr-db-pre-encrypt-20261001` is the pre-cutover copy of `rwr-db`.

## Restore

1. List snapshots for `rwr-db-enc` and choose one from the last 7 days.
2. Restore that snapshot to a new cluster id. The snapshot is already encrypted, so the new cluster stays encrypted. Use subnet group `rwr-db-subnets`, security group `sg-03efb7c24f17634fa`, engine `aurora-postgresql` 16.9, and a `db.serverless` instance that is not publicly accessible. Set backup retention to 7 days and turn deletion protection on.
3. Enable the HTTP endpoint (Data API) and the same Serverless v2 range: minimum 0 ACU, maximum 2 ACU, pause after 300 seconds.
4. Read the new cluster's managed master-user secret.
5. Add the new cluster ARN to the `rwr-api` policy on `rwr-api-lambda-role`, then set `CLUSTER_ARN` and `SECRET_ARN` on `rwr-intake` and `rwr-admin`.
6. Confirm `SELECT COUNT(*) FROM submissions` on the new cluster matches the previous count before sending traffic there.
7. Leave `rwr-db-enc` in place until that check succeeds. Deletion protection has to be turned off before it can be removed.
