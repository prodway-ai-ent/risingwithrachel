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
  if (!token || !COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const jwk = await signingKey(header.kid);
    if (!jwk || header.alg !== "RS256") return false;
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const valid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], "base64url"),
    );
    return valid
      && payload.iss === ISSUER
      && payload.aud === COGNITO_CLIENT_ID
      && payload.token_use === "id"
      && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
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

  if (method === "GET" && path.endsWith("/submissions")) {
    const auth = event?.headers?.authorization || event?.headers?.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!(await verifyToken(token))) return json(401, { ok: false, error: "Unauthorized" });

    try {
      const res = await execWithResume(new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DB_NAME,
        sql: `SELECT id, created_at, name, email, phone, location, experience,
                     preferred_contact, goals, message
              FROM submissions ORDER BY created_at DESC LIMIT 500`,
        formatRecordsAs: "JSON",
      }));
      const rows = res.formattedRecords ? JSON.parse(res.formattedRecords) : [];
      return json(200, { ok: true, submissions: rows });
    } catch (err) {
      console.error("Query failed:", err);
      return json(500, { ok: false, error: "Query failed" });
    }
  }

  return json(404, { ok: false, error: "Not found" });
};
