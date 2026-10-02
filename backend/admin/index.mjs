import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";

const rds = new RDSDataClient({});
const cognito = new CognitoIdentityProviderClient({});

async function execWithResume(command, attempts = 10, delayMs = 4000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await rds.send(command);
    } catch (e) {
      if (e?.name === "DatabaseResumingException" && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
}

const {
  CLUSTER_ARN,
  SECRET_ARN,
  DB_NAME = "rwr",
  COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID,
} = process.env;

const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${COGNITO_USER_POOL_ID}`;
const CORS = {
  "Access-Control-Allow-Origin": "https://risingwithrachel.com",
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

let jwks = { keys: [], fetched: 0 };

async function signingKey(kid) {
  if (!jwks.keys.length || Date.now() - jwks.fetched > 60 * 60 * 1000) {
    const res = await fetch(`${ISSUER}/.well-known/jwks.json`);
    if (!res.ok) throw new Error("Could not load signing keys");
    jwks = { keys: (await res.json()).keys || [], fetched: Date.now() };
  }
  return jwks.keys.find((key) => key.kid === kid);
}

async function verifyToken(token) {
  if (!token || !COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const jwk = await signingKey(header.kid);
    if (!jwk || header.alg !== "RS256") return null;
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const valid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], "base64url"),
    );
    if (!valid || payload.iss !== ISSUER || payload.aud !== COGNITO_CLIENT_ID || payload.token_use !== "id" || payload.exp * 1000 <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

const textParam = (name, value) => ({
  name,
  value: value ? { stringValue: String(value) } : { isNull: true },
});
const longParam = (name, value) => ({ name, value: { longValue: Number(value) } });

async function query(sql, parameters) {
  const res = await execWithResume(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DB_NAME,
    sql,
    parameters,
    formatRecordsAs: "JSON",
  }));
  return res.formattedRecords ? JSON.parse(res.formattedRecords) : [];
}

async function requireUser(event) {
  const auth = event?.headers?.authorization || event?.headers?.Authorization || "";
  return verifyToken(auth.replace(/^Bearer\s+/i, ""));
}

function authed(result) {
  return json(200, { ok: true, token: result.IdToken });
}

async function fromChallenge(email, out) {
  if (out.AuthenticationResult?.IdToken) return authed(out.AuthenticationResult);
  if (out.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    return json(200, { ok: true, challenge: "NEW_PASSWORD", session: out.Session });
  }
  if (out.ChallengeName === "SOFTWARE_TOKEN_MFA") {
    return json(200, { ok: true, challenge: "SOFTWARE_TOKEN_MFA", session: out.Session });
  }
  if (out.ChallengeName === "MFA_SETUP") {
    const assoc = await cognito.send(new AssociateSoftwareTokenCommand({ Session: out.Session }));
    return json(200, { ok: true, challenge: "MFA_SETUP", session: assoc.Session, secret: assoc.SecretCode });
  }
  return json(400, { ok: false, error: "Unexpected sign-in step." });
}

function authError(err) {
  const name = err?.name || "";
  if (name === "NotAuthorizedException" || name === "UserNotFoundException") {
    return json(401, { ok: false, error: "Incorrect email or password." });
  }
  if (name === "CodeMismatchException" || name === "EnableSoftwareTokenMFAException") {
    return json(401, { ok: false, error: "That code didn't match." });
  }
  if (name === "ExpiredCodeException") {
    return json(401, { ok: false, error: "That code expired. Enter the next one." });
  }
  if (name === "InvalidPasswordException") {
    return json(400, { ok: false, error: "Use at least 12 characters with upper and lower case letters, a number, and a symbol." });
  }
  console.error("Sign-in failed:", err);
  return json(500, { ok: false, error: "Sign-in failed." });
}

async function login(body) {
  const email = String(body.email || "").trim();
  if (!email) return json(400, { ok: false, error: "Email is required." });
  try {
    if (!body.challenge) {
      const out = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: body.password || "" },
      }));
      return await fromChallenge(email, out);
    }
    if (body.challenge === "NEW_PASSWORD") {
      const out = await cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: body.session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: body.newPassword || "" },
      }));
      return await fromChallenge(email, out);
    }
    if (body.challenge === "SOFTWARE_TOKEN_MFA") {
      const out = await cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: body.session,
        ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: String(body.code || "").trim() },
      }));
      return await fromChallenge(email, out);
    }
    if (body.challenge === "MFA_SETUP") {
      const verified = await cognito.send(new VerifySoftwareTokenCommand({
        Session: body.session,
        UserCode: String(body.code || "").trim(),
        FriendlyDeviceName: "authenticator",
      }));
      const out = await cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: "MFA_SETUP",
        Session: verified.Session,
        ChallengeResponses: { USERNAME: email },
      }));
      return await fromChallenge(email, out);
    }
    return json(400, { ok: false, error: "Unexpected sign-in step." });
  } catch (err) {
    return authError(err);
  }
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method;
  const path = event?.requestContext?.http?.path || event?.rawPath || "";
  if (method === "OPTIONS") return json(200, { ok: true });

  if (method === "POST" && path.endsWith("/login")) {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
    return login(body);
  }

  const user = await requireUser(event);
  if (!user) return json(401, { ok: false, error: "Unauthorized" });

  const clientMatch = path.match(/\/clients\/(\d+)$/);

  try {
    if (method === "GET" && path.endsWith("/submissions")) {
      const rows = await query(`SELECT id, created_at, name, email, phone, location, experience,
                     preferred_contact, goals, message, client_id
              FROM submissions ORDER BY created_at DESC LIMIT 500`);
      return json(200, { ok: true, submissions: rows });
    }

    if (method === "GET" && clientMatch) {
      const id = clientMatch[1];
      const clients = await query(
        `SELECT id, created_at, name, email, phone, location, notes
         FROM clients WHERE id = :id`,
        [longParam("id", id)],
      );
      if (!clients.length) return json(404, { ok: false, error: "Client not found." });
      const submissions = await query(
        `SELECT id, created_at, experience, goals, message
         FROM submissions WHERE client_id = :id ORDER BY created_at DESC`,
        [longParam("id", id)],
      );
      return json(200, { ok: true, client: clients[0], submissions });
    }

    if (method === "GET" && path.endsWith("/clients")) {
      const rows = await query(`SELECT id, created_at, name, email, phone, location, notes
              FROM clients ORDER BY created_at DESC LIMIT 500`);
      return json(200, { ok: true, clients: rows });
    }

    if (method === "POST" && path.endsWith("/clients")) {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      if (!name || !email) return json(400, { ok: false, error: "Name and email are required." });
      if (body.submissionId) {
        const existing = await query(
          "SELECT client_id FROM submissions WHERE id = :id",
          [longParam("id", body.submissionId)],
        );
        if (!existing.length) return json(404, { ok: false, error: "Inquiry not found." });
        if (existing[0].client_id) {
          return json(409, { ok: false, error: "This inquiry is already a client.", clientId: existing[0].client_id });
        }
      }
      const created = await query(
        `INSERT INTO clients (name, email, phone, location, notes, created_by)
         VALUES (:name, :email, :phone, :location, :notes, :created_by)
         RETURNING id, created_at, name, email, phone, location, notes`,
        [
          textParam("name", name),
          textParam("email", email),
          textParam("phone", body.phone),
          textParam("location", body.location),
          textParam("notes", body.notes),
          textParam("created_by", user.email),
        ],
      );
      if (body.submissionId) {
        await query(
          "UPDATE submissions SET client_id = :clientId, updated_at = now() WHERE id = :id AND client_id IS NULL",
          [longParam("clientId", created[0].id), longParam("id", body.submissionId)],
        );
      }
      return json(200, { ok: true, client: created[0] });
    }

    if (method === "PATCH" && clientMatch) {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
      const updated = await query(
        `UPDATE clients
         SET notes = :notes, updated_at = now()
         WHERE id = :id
         RETURNING id, created_at, name, email, phone, location, notes`,
        [textParam("notes", body.notes), longParam("id", clientMatch[1])],
      );
      if (!updated.length) return json(404, { ok: false, error: "Client not found." });
      return json(200, { ok: true, client: updated[0] });
    }
  } catch (err) {
    console.error("Client request failed:", err);
    return json(500, { ok: false, error: "Request failed" });
  }

  return json(404, { ok: false, error: "Not found" });
};
