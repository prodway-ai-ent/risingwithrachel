import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";

const dir = path.dirname(fileURLToPath(import.meta.url));
const { CLUSTER_ARN, SECRET_ARN, DB_NAME = "rwr" } = process.env;

if (!CLUSTER_ARN || !SECRET_ARN) {
  console.error("Set CLUSTER_ARN, SECRET_ARN, and AWS_REGION.");
  process.exit(1);
}

const rds = new RDSDataClient({});

async function exec(sql, parameters) {
  const command = new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DB_NAME,
    sql,
    parameters,
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await rds.send(command);
    } catch (err) {
      if (err?.name === "DatabaseResumingException" && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      throw err;
    }
  }
}

function statements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((part) => part
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim())
    .filter(Boolean);
}

await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);

const applied = new Set(
  (await exec("SELECT version FROM schema_migrations")).records?.map((row) => row[0].stringValue) ?? [],
);

const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  if (applied.has(version)) {
    console.log(`skip ${version}`);
    continue;
  }
  const sql = await readFile(path.join(dir, file), "utf8");
  for (const statement of statements(sql)) {
    await exec(statement);
  }
  await exec(
    "INSERT INTO schema_migrations (version) VALUES (:version)",
    [{ name: "version", value: { stringValue: version } }],
  );
  console.log(`applied ${version}`);
}
