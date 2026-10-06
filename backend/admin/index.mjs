import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import crypto from "node:crypto";

const rds = new RDSDataClient({});
const cognito = new CognitoIdentityProviderClient({});
const ses = new SESv2Client({});
const secrets = new SecretsManagerClient({});

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
  GOOGLE_CALENDAR_SECRET_ARN,
  STRIPE_SECRET_ARN,
  FROM_ADDRESS,
  NOTIFY_ADDRESS,
} = process.env;

const SITE = "https://risingwithrachel.com";

const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${COGNITO_USER_POOL_ID}`;
const CORS = {
  "Access-Control-Allow-Origin": "https://risingwithrachel.com",
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
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
  value: value === undefined || value === null || value === "" ? { isNull: true } : { stringValue: String(value) },
});
const longParam = (name, value) => ({ name, value: { longValue: Number(value) } });
const boolParam = (name, value) => ({ name, value: { booleanValue: Boolean(value) } });
const isConflict = (err) => /exclusion constraint|duplicate key/i.test(String(err?.message || ""));

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

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DURATIONS = new Set([30, 45, 60, 90]);
const esc = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

function zoneParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    weekday: WEEKDAY_INDEX[parts.weekday],
    minutes: hour * 60 + Number(parts.minute),
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function zoneOffsetMs(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}

function utcFromLocal(localValue, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(localValue || ""));
  if (!match) return null;
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let utc = guess - zoneOffsetMs(guess, timeZone);
  let parts = zoneParts(new Date(utc), timeZone);
  const wanted = Number(match[4]) * 60 + Number(match[5]);
  const wantedDay = `${match[1]}-${match[2]}-${match[3]}`;
  if (parts.minutes !== wanted || parts.day !== wantedDay) {
    utc = guess - zoneOffsetMs(utc, timeZone);
    parts = zoneParts(new Date(utc), timeZone);
    if (parts.minutes !== wanted || parts.day !== wantedDay) return null;
  }
  return new Date(utc);
}

function clock(minutes) {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return minute ? `${hour}:${String(minute).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

function zoneWord(timeZone) {
  if (timeZone === "America/New_York") return "Eastern";
  if (timeZone === "America/Chicago") return "Central";
  return timeZone;
}

function availabilityLabel(rule) {
  const active = rule.rules;
  if (!active.length) return `No hours are open right now (${zoneWord(rule.timezone)})`;
  const names = active.map((day) => WEEKDAY_NAMES[day.weekday]);
  const contiguous = active.every((day, index) => index === 0 || day.weekday === active[index - 1].weekday + 1);
  const span = names.length === 1
    ? names[0]
    : contiguous ? `${names[0]} through ${names[names.length - 1]}` : names.join(", ");
  const sameHours = active.every((day) => day.start_minute === active[0].start_minute && day.end_minute === active[0].end_minute);
  const hours = sameHours ? `${clock(active[0].start_minute)} to ${clock(active[0].end_minute)}` : "hours vary by day";
  return `${span}, ${hours} ${zoneWord(rule.timezone)}`;
}

// Availability lives in our own tables: one timezone and slot length, a weekly
// rule per weekday, and blocked spans in UTC. Nothing here reads an external calendar.
async function loadAvailability() {
  const settings = await query("SELECT timezone, slot_minutes, horizon_days FROM availability WHERE id = 1");
  if (!settings.length) throw new Error("Availability is not configured.");
  const rules = await query(
    "SELECT weekday, start_minute, end_minute FROM availability_rules WHERE active ORDER BY weekday",
  );
  return {
    timezone: settings[0].timezone,
    slot_minutes: Number(settings[0].slot_minutes || 60),
    horizon_days: Number(settings[0].horizon_days || 28),
    rules: rules.map((row) => ({
      weekday: Number(row.weekday),
      start_minute: Number(row.start_minute),
      end_minute: Number(row.end_minute),
    })),
  };
}

function ruleForWeekday(rule, weekday) {
  return rule.rules.find((day) => day.weekday === weekday) || null;
}

function withinHours(start, end, rule) {
  const startParts = zoneParts(start, rule.timezone);
  const endParts = zoneParts(end, rule.timezone);
  const day = ruleForWeekday(rule, startParts.weekday);
  return Boolean(day)
    && startParts.day === endParts.day
    && startParts.minutes >= day.start_minute
    && endParts.minutes <= day.end_minute
    && endParts.minutes > startParts.minutes;
}

async function blocksBetween(start, end) {
  const rows = await query(
    `SELECT id, starts_at, ends_at, reason FROM availability_blocks
     WHERE starts_at < CAST(:end AS timestamptz) AND ends_at > CAST(:start AS timestamptz)
     ORDER BY starts_at`,
    [textParam("start", start.toISOString()), textParam("end", end.toISOString())],
  );
  return rows.map((row) => ({ ...row, start: parseDbTime(row.starts_at), end: parseDbTime(row.ends_at) }));
}

async function busyBetween(start, end) {
  const rows = await query(
    `SELECT s.id, s.starts_at, s.ends_at, s.status, c.name, c.email
     FROM sessions s JOIN clients c ON c.id = s.client_id
     WHERE s.status IN ('pending', 'approved', 'scheduled')
       AND s.starts_at < CAST(:end AS timestamptz) AND s.ends_at > CAST(:start AS timestamptz)`,
    [textParam("start", start.toISOString()), textParam("end", end.toISOString())],
  );
  return rows.map((row) => ({ ...row, start: parseDbTime(row.starts_at), end: parseDbTime(row.ends_at) }));
}

let calendarSecretCache;

async function loadCalendarSecret() {
  if (calendarSecretCache) return calendarSecretCache;
  if (!GOOGLE_CALENDAR_SECRET_ARN) return null;
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: GOOGLE_CALENDAR_SECRET_ARN }));
  calendarSecretCache = JSON.parse(out.SecretString || "{}");
  return calendarSecretCache;
}

function credentialsReady(secret) {
  if (!secret) return false;
  return ["client_id", "client_secret", "refresh_token"].every((key) => {
    const value = String(secret[key] || "");
    return value && !value.startsWith("dummy");
  });
}

async function googleAccessToken(secret) {
  const body = new URLSearchParams({
    client_id: secret.client_id,
    client_secret: secret.client_secret,
    refresh_token: secret.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    throw new Error(payload.error_description || "Google token request failed");
  }
  return payload.access_token;
}

// Dormant until real provider credentials exist. Bookings work entirely from our
// own tables; this only mirrors a confirmed session out once a provider is connected.
async function syncCalendar(action, session, client, rule) {
  const secret = await loadCalendarSecret();
  if (!credentialsReady(secret)) {
    return { status: "none", eventId: session.external_event_id || null, error: null };
  }
  const token = await googleAccessToken(secret);
  const calendarId = encodeURIComponent(secret.calendar_id || "primary");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (action === "update" && session.external_event_id) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(session.external_event_id)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          start: { dateTime: session.starts_at, timeZone: rule.timezone },
          end: { dateTime: session.ends_at, timeZone: rule.timezone },
        }),
      },
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error?.message || "Could not update the Google Calendar event");
    return { status: "synced", eventId: session.external_event_id, error: null };
  }
  if (action === "delete") {
    if (!session.external_event_id) return { status: "cancelled", eventId: null, error: null };
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(session.external_event_id)}`,
      { method: "DELETE", headers },
    );
    if (!res.ok && res.status !== 410 && res.status !== 404) {
      throw new Error("Could not remove the Google Calendar event");
    }
    return { status: "cancelled", eventId: null, error: null };
  }
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      summary: `Coaching session with ${client.name}`,
      description: "Booked from the Rising with Rachel admin.",
      start: { dateTime: session.starts_at, timeZone: rule.timezone },
      end: { dateTime: session.ends_at, timeZone: rule.timezone },
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.id) throw new Error(payload.error?.message || "Could not create the Google Calendar event");
  return { status: "synced", eventId: payload.id, error: null };
}

async function writeCalendarResult(id, result) {
  const rows = await query(
    `UPDATE sessions
     SET external_event_id = :eventId,
         calendar_provider = CASE WHEN :eventId IS NULL THEN NULL ELSE 'google' END,
         calendar_sync_status = :status,
         calendar_sync_error = :error,
         updated_at = now()
     WHERE id = :id
     RETURNING id, client_id, starts_at, ends_at, status, calendar_sync_status, external_event_id`,
    [
      textParam("eventId", result.eventId),
      textParam("status", result.status),
      textParam("error", result.error),
      longParam("id", id),
    ],
  );
  return rows[0];
}

function whenLabel(start, rule) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: rule.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(start);
}

function manageLink(token) {
  return `${SITE}/session/${token}`;
}

async function sendMail(to, subject, html) {
  if (!FROM_ADDRESS || !to) return { emailSent: false, emailError: "Confirmation email is not configured." };
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: `Rising with Rachel <${FROM_ADDRESS}>`,
      Destination: { ToAddresses: [to] },
      ReplyToAddresses: [NOTIFY_ADDRESS || FROM_ADDRESS],
      Content: { Simple: {
        Subject: { Data: subject },
        Body: { Html: { Data: html } },
      } },
    }));
    return { emailSent: true };
  } catch (err) {
    console.error("Session email failed:", err);
    const sandbox = err?.name === "MessageRejected";
    return {
      emailSent: false,
      emailError: sandbox
        ? "Confirmation email was not sent because this address cannot receive mail yet."
        : "Confirmation email was not sent.",
    };
  }
}

function sessionLetter(firstName, when, intro, token) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;color:#111">
      <h2 style="color:#2563eb">${esc(intro)}</h2>
      <p>Hi ${esc(firstName)},</p>
      <p>Your coaching session with Rachel is booked for <strong>${esc(when)}</strong>.</p>
      <p><a href="${esc(manageLink(token))}">Change or cancel this session</a></p>
      <p style="margin-top:24px">Rachel<br/><span style="color:#888">Rising with Rachel</span></p>
    </div>`;
}

async function sendConfirmation(client, start, rule, token) {
  const first = String(client.name || "").split(" ")[0];
  return sendMail(
    client.email,
    "Your session with Rising with Rachel is confirmed",
    sessionLetter(first, whenLabel(start, rule), "Your session is confirmed", token),
  );
}

const SESSION_COLUMNS = "id, client_id, starts_at, ends_at, status, calendar_sync_status, external_event_id";

async function planSession(startsAt, durationMinutes, excludeId) {
  const duration = Number(durationMinutes);
  if (!DURATIONS.has(duration)) return { error: json(400, { ok: false, error: "Choose a 30, 45, 60, or 90 minute session." }) };
  const rule = await loadAvailability();
  const start = utcFromLocal(startsAt, rule.timezone);
  if (!start) return { error: json(400, { ok: false, error: "Enter a valid start time." }) };
  if (start.getTime() <= Date.now()) return { error: json(400, { ok: false, error: "Choose a start time in the future." }) };
  const end = new Date(start.getTime() + duration * 60 * 1000);
  if (!withinHours(start, end, rule)) {
    return { error: json(400, { ok: false, error: `Sessions are ${availabilityLabel(rule)}.` }) };
  }
  const blocked = await blocksBetween(start, end);
  if (blocked.length) return { error: json(409, { ok: false, error: "That time is blocked off." }) };
  const parameters = [textParam("ends", end.toISOString()), textParam("starts", start.toISOString())];
  let exclude = "";
  if (excludeId) {
    exclude = " AND id <> :excludeId";
    parameters.push(longParam("excludeId", excludeId));
  }
  const overlap = await query(
    `SELECT id FROM sessions
     WHERE status IN ('pending', 'approved', 'scheduled') AND starts_at < CAST(:ends AS timestamptz) AND ends_at > CAST(:starts AS timestamptz)${exclude}
     LIMIT 1`,
    parameters,
  );
  if (overlap.length) return { error: json(409, { ok: false, error: "That time overlaps another session." }) };
  return { start, end, rule };
}

async function bookSession(body, user) {
  if (!body.clientId) return json(400, { ok: false, error: "Choose a client." });
  const plan = await planSession(body.startsAt, body.durationMinutes);
  if (plan.error) return plan.error;
  const { start, end, rule } = plan;
  const clients = await query(
    "SELECT id, name, email FROM clients WHERE id = :id",
    [longParam("id", body.clientId)],
  );
  if (!clients.length) return json(404, { ok: false, error: "Client not found." });
  const manageToken = crypto.randomBytes(24).toString("base64url");
  let created;
  try {
    created = await query(
      `INSERT INTO sessions (client_id, starts_at, ends_at, status, created_by, calendar_sync_status, manage_token)
       VALUES (:clientId, CAST(:starts AS timestamptz), CAST(:ends AS timestamptz), 'scheduled', :created_by, 'none', :token)
       RETURNING ${SESSION_COLUMNS}`,
      [
        longParam("clientId", body.clientId),
        textParam("starts", start.toISOString()),
        textParam("ends", end.toISOString()),
        textParam("created_by", user.email),
        textParam("token", manageToken),
      ],
    );
  } catch (err) {
    if (isConflict(err)) return json(409, { ok: false, error: "That time was just taken." });
    throw err;
  }
  const mail = await sendConfirmation(clients[0], start, rule, manageToken);
  let session = created[0];
  try {
    const synced = await syncCalendar("create", {
      ...session,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
    }, clients[0], rule);
    session = await writeCalendarResult(session.id, synced);
  } catch (err) {
    console.error("Calendar sync failed:", err);
    session = await writeCalendarResult(session.id, {
      status: "error",
      eventId: null,
      error: "Google Calendar did not accept this session.",
    });
  }
  return json(200, { ok: true, session, ...mail, availabilityLabel: availabilityLabel(rule) });
}

async function cancelSession(id) {
  const existing = await query(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = :id`,
    [longParam("id", id)],
  );
  if (!existing.length) return json(404, { ok: false, error: "Session not found." });
  if (existing[0].status === "cancelled") return json(200, { ok: true, session: existing[0] });
  const rule = await loadAvailability();
  const cancelled = await query(
    `UPDATE sessions SET status = 'cancelled', updated_at = now()
     WHERE id = :id
     RETURNING ${SESSION_COLUMNS}`,
    [longParam("id", id)],
  );
  let session = cancelled[0];
  try {
    const synced = await syncCalendar("delete", session, {}, rule);
    session = await writeCalendarResult(session.id, synced.status === "none"
      ? { status: "none", eventId: session.external_event_id, error: null }
      : synced);
  } catch (err) {
    console.error("Calendar delete failed:", err);
    session = await writeCalendarResult(session.id, {
      status: "error",
      eventId: session.external_event_id,
      error: "Google Calendar did not remove this session.",
    });
  }
  return json(200, { ok: true, session });
}

async function sessionByToken(token) {
  const rows = await query(
    `SELECT s.id, s.client_id, s.starts_at, s.ends_at, s.status, s.manage_token, s.external_event_id, s.calendar_sync_status,
            c.name, c.email
     FROM sessions s JOIN clients c ON c.id = s.client_id
     WHERE s.manage_token = :token`,
    [textParam("token", token)],
  );
  return rows[0] || null;
}

function publicSession(row, rule) {
  return json(200, {
    ok: true,
    session: { status: row.status, starts_at: row.starts_at, ends_at: row.ends_at, name: row.name },
    availabilityLabel: availabilityLabel(rule),
  });
}

async function manageSession(token, action, body) {
  const row = await sessionByToken(token);
  if (!row) return json(400, { ok: false, error: "This link is not valid." });
  const rule = await loadAvailability();
  if (action === "get") return publicSession(row, rule);
  const starts = new Date(String(row.starts_at).includes("T") ? row.starts_at : String(row.starts_at).replace(" ", "T") + "Z");
  if (row.status !== "scheduled" || starts.getTime() <= Date.now()) {
    return json(400, { ok: false, error: "This session can no longer be changed." });
  }
  if (action === "cancel") {
    const result = await cancelSession(row.id);
    const first = String(row.name).split(" ")[0];
    await sendMail(row.email, "Your session with Rising with Rachel was cancelled", `
      <div style="font-family:Arial,sans-serif;max-width:560px;color:#111">
        <p>Hi ${esc(first)},</p>
        <p>Your coaching session has been cancelled.</p>
        <p style="margin-top:24px">Rachel<br/><span style="color:#888">Rising with Rachel</span></p>
      </div>`);
    const parsed = JSON.parse(result.body);
    return json(result.statusCode, { ...parsed, notice: "This session is cancelled." });
  }
  const plan = await planSession(body.startsAt, body.durationMinutes, row.id);
  if (plan.error) return plan.error;
  let updated;
  try {
    updated = await query(
      `UPDATE sessions
       SET starts_at = CAST(:starts AS timestamptz), ends_at = CAST(:ends AS timestamptz),
           reminder_24h_sent_at = NULL, reminder_1h_sent_at = NULL, updated_at = now()
       WHERE id = :id
       RETURNING ${SESSION_COLUMNS}, manage_token`,
      [
        textParam("starts", plan.start.toISOString()),
        textParam("ends", plan.end.toISOString()),
        longParam("id", row.id),
      ],
    );
  } catch (err) {
    if (isConflict(err)) return json(409, { ok: false, error: "That time was just taken." });
    throw err;
  }
  try {
    const synced = await syncCalendar("update", {
      ...updated[0],
      external_event_id: row.external_event_id,
      starts_at: plan.start.toISOString(),
      ends_at: plan.end.toISOString(),
    }, row, plan.rule);
    if (synced.status !== "none") await writeCalendarResult(row.id, synced);
  } catch (err) {
    console.error("Calendar update failed:", err);
    await writeCalendarResult(row.id, {
      status: "error",
      eventId: row.external_event_id,
      error: "Google Calendar did not accept the new time.",
    });
  }
  const first = String(row.name).split(" ")[0];
  await sendMail(
    row.email,
    "Your session with Rising with Rachel was rescheduled",
    sessionLetter(first, whenLabel(plan.start, plan.rule), "Your session was rescheduled", row.manage_token),
  );
  return json(200, { ...(JSON.parse(publicSession(updated[0], plan.rule).body)), notice: "Your session was rescheduled." });
}

async function sendReminders() {
  const rule = await loadAvailability();
  const due = await query(
    `SELECT s.id, s.starts_at, s.manage_token, s.reminder_24h_sent_at, s.reminder_1h_sent_at, c.name, c.email
     FROM sessions s JOIN clients c ON c.id = s.client_id
     WHERE s.status = 'scheduled' AND s.starts_at > now() AND (
       (s.reminder_1h_sent_at IS NULL AND s.starts_at <= now() + interval '75 minutes' AND s.starts_at > now() + interval '30 minutes')
       OR (s.reminder_24h_sent_at IS NULL AND s.starts_at <= now() + interval '25 hours' AND s.starts_at > now() + interval '22 hours')
     )`,
  );
  let sent = 0;
  for (const row of due) {
    const start = new Date(String(row.starts_at).includes("T") ? row.starts_at : String(row.starts_at).replace(" ", "T") + "Z");
    const soon = start.getTime() - Date.now() <= 75 * 60 * 1000;
    const kind = soon ? "1h" : "24h";
    const subject = soon
      ? "Your session with Rachel starts in about an hour"
      : "Your session with Rachel is coming up";
    const intro = soon ? "Your session starts in about an hour" : "Your session is coming up";
    const mail = await sendMail(
      row.email,
      subject,
      sessionLetter(String(row.name).split(" ")[0], whenLabel(start, rule), intro, row.manage_token),
    );
    if (!mail.emailSent) continue;
    sent += 1;
    const column = kind === "1h" ? "reminder_1h_sent_at" : "reminder_24h_sent_at";
    await query(`UPDATE sessions SET ${column} = now(), updated_at = now() WHERE id = :id`, [longParam("id", row.id)]);
  }
  return { ok: true, due: due.length, sent };
}

let stripeSecretCache;
async function loadStripeSecret() {
  if (stripeSecretCache) return stripeSecretCache;
  if (!STRIPE_SECRET_ARN) return null;
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: STRIPE_SECRET_ARN }));
  stripeSecretCache = JSON.parse(out.SecretString || "{}");
  return stripeSecretCache;
}

function stripeReady(secret) {
  if (!secret) return false;
  return ["secret_key", "publishable_key", "webhook_secret"].every((key) => {
    const value = String(secret[key] || "");
    return value && !value.startsWith("dummy");
  });
}

function stripeSignatureValid(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(",").map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index), part.slice(index + 1)];
  }));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  const given = parts.v1;
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

async function stripeWebhook(event) {
  const secret = await loadStripeSecret();
  if (!stripeReady(secret)) return json(404, { ok: false, error: "Not found" });
  const payload = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  const header = event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"] || "";
  if (!stripeSignatureValid(payload, header, secret.webhook_secret)) {
    return json(400, { ok: false, error: "Invalid signature" });
  }
  let body;
  try { body = JSON.parse(payload); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
  if (body.type !== "checkout.session.completed" && body.type !== "charge.refunded") {
    return json(200, { ok: true });
  }
  const object = body.data?.object || {};
  const email = object.customer_details?.email || object.billing_details?.email || object.receipt_email || "";
  const clients = email
    ? await query("SELECT id FROM clients WHERE lower(email) = lower(:email) LIMIT 1", [textParam("email", email)])
    : [];
  const amount = object.amount_total ?? object.amount_refunded ?? object.amount ?? null;
  await query(
    `INSERT INTO payments (client_id, stripe_event_id, stripe_object_id, amount_cents, currency, status, created_by)
     VALUES (CAST(:clientId AS bigint), :eventId, :objectId, CAST(:amount AS integer), :currency, :status, 'stripe')
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [
      clients[0] ? longParam("clientId", clients[0].id) : textParam("clientId", null),
      textParam("eventId", body.id),
      textParam("objectId", object.id),
      amount == null ? textParam("amount", null) : longParam("amount", amount),
      textParam("currency", object.currency),
      textParam("status", body.type),
    ],
  );
  return json(200, { ok: true });
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportCsv() {
  const clients = await query("SELECT id, name, email, phone, location, notes, created_at FROM clients ORDER BY id");
  const sessions = await query("SELECT id, client_id, starts_at, ends_at, status FROM sessions ORDER BY starts_at");
  const lines = [["record", "id", "client_id", "name", "email", "phone", "location", "notes", "starts_at", "ends_at", "status"].join(",")];
  for (const row of clients) {
    lines.push(["client", row.id, "", row.name, row.email, row.phone, row.location, row.notes, "", "", ""].map(csvCell).join(","));
  }
  for (const row of sessions) {
    lines.push(["session", row.id, row.client_id, "", "", "", "", "", row.starts_at, row.ends_at, row.status].map(csvCell).join(","));
  }
  return {
    statusCode: 200,
    headers: {
      ...CORS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="rising-with-rachel.csv"',
    },
    body: `${lines.join("\n")}\n`,
  };
}

function addDays(day, count) {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + count));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function parseDbTime(value) {
  const text = String(value || "");
  return new Date(text.includes("T") || text.endsWith("Z") ? text : `${text.replace(" ", "T")}Z`);
}

async function calendarDays(includePrivate) {
  const rule = await loadAvailability();
  const slotMinutes = rule.slot_minutes;
  const now = new Date();
  const horizonEnd = new Date(now.getTime() + (rule.horizon_days + 1) * 86400000);
  const [busy, blocks] = await Promise.all([busyBetween(now, horizonEnd), blocksBetween(now, horizonEnd)]);
  const today = zoneParts(now, rule.timezone).day;
  const days = [];
  for (let offset = 0; offset <= rule.horizon_days; offset += 1) {
    const day = addDays(today, offset);
    const noon = utcFromLocal(`${day}T12:00`, rule.timezone);
    if (!noon) continue;
    const dayRule = ruleForWeekday(rule, zoneParts(noon, rule.timezone).weekday);
    if (!dayRule) continue;
    const slots = [];
    for (let minute = dayRule.start_minute; minute + slotMinutes <= dayRule.end_minute; minute += slotMinutes) {
      const local = `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      const start = utcFromLocal(local, rule.timezone);
      if (!start || start.getTime() <= now.getTime()) continue;
      const end = new Date(start.getTime() + slotMinutes * 60 * 1000);
      const block = blocks.find((row) => row.start < end && row.end > start);
      const hit = busy.find((row) => row.start < end && row.end > start);
      const slot = { startsAt: start.toISOString(), label: clock(minute) };
      if (block) {
        if (!includePrivate) continue;
        slot.status = "blocked";
        slot.blockId = block.id;
        slot.reason = block.reason || null;
      } else if (hit) {
        slot.status = includePrivate ? hit.status : "taken";
        if (includePrivate) {
          slot.sessionId = hit.id;
          slot.name = hit.name;
          slot.email = hit.email;
        }
      } else {
        slot.status = "available";
      }
      slots.push(slot);
    }
    if (!slots.length) continue;
    if (!includePrivate && !slots.some((slot) => slot.status === "available")) continue;
    days.push({
      day,
      label: new Intl.DateTimeFormat("en-US", { timeZone: rule.timezone, weekday: "long", month: "short", day: "numeric" }).format(noon),
      slots,
    });
  }
  return {
    days,
    timezone: rule.timezone,
    timezoneLabel: `${zoneWord(rule.timezone)} Time`,
    slotMinutes,
    availabilityLabel: availabilityLabel(rule),
  };
}

async function requestSlot(body) {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const phone = String(body.phone || "").trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { ok: false, error: "Name and a valid email are required." });
  }
  const start = new Date(String(body.startsAt || ""));
  if (Number.isNaN(start.getTime()) || start.getMilliseconds() !== 0) {
    return json(400, { ok: false, error: "Choose one of the available times." });
  }
  const rule = await loadAvailability();
  const slotMinutes = rule.slot_minutes;
  const end = new Date(start.getTime() + slotMinutes * 60 * 1000);
  const parts = zoneParts(start, rule.timezone);
  const dayRule = ruleForWeekday(rule, parts.weekday);
  const onGrid = Boolean(dayRule) && (parts.minutes - dayRule.start_minute) % slotMinutes === 0 && start.getUTCSeconds() === 0;
  const tooLate = start.getTime() > Date.now() + (rule.horizon_days + 1) * 86400000;
  if (!onGrid || !withinHours(start, end, rule) || start.getTime() <= Date.now() || tooLate) {
    return json(400, { ok: false, error: "Choose one of the available times." });
  }
  const blocked = await blocksBetween(start, end);
  if (blocked.length) return json(409, { ok: false, error: "That time is no longer available. Please choose another." });
  let clients = await query(
    "SELECT id, name, email FROM clients WHERE lower(email) = lower(:email) ORDER BY id DESC LIMIT 1",
    [textParam("email", email)],
  );
  if (!clients.length) {
    clients = await query(
      `INSERT INTO clients (name, email, phone, created_by)
       VALUES (:name, :email, :phone, 'booking')
       RETURNING id, name, email`,
      [textParam("name", name), textParam("email", email), textParam("phone", phone)],
    );
  }
  const manageToken = crypto.randomBytes(24).toString("base64url");
  try {
    // The exclusion constraint on sessions rejects a second active booking for an
    // overlapping span, so two visitors cannot both hold the same hour.
    await query(
      `INSERT INTO sessions (client_id, starts_at, ends_at, status, created_by, calendar_sync_status, manage_token)
       VALUES (:clientId, CAST(:starts AS timestamptz), CAST(:ends AS timestamptz), 'pending', 'booking', 'none', :token)`,
      [
        longParam("clientId", clients[0].id),
        textParam("starts", start.toISOString()),
        textParam("ends", end.toISOString()),
        textParam("token", manageToken),
      ],
    );
  } catch (err) {
    if (isConflict(err)) {
      return json(409, { ok: false, error: "That time was just requested by someone else. Please choose another." });
    }
    throw err;
  }
  const when = whenLabel(start, rule);
  await sendMail(
    NOTIFY_ADDRESS,
    `Phone call request from ${name}`,
    `<div style="font-family:Arial,sans-serif;color:#111"><p><strong>${esc(name)}</strong> (${esc(email)}${phone ? `, ${esc(phone)}` : ""}) requested ${esc(when)}.</p><p>Approve or decline it in the admin calendar.</p></div>`,
  );
  return json(200, {
    ok: true,
    request: { status: "pending", startsAt: start.toISOString(), when, timezone: rule.timezone },
    notice: "Your request is pending. Rachel will review it and follow up by email to confirm.",
  });
}

async function sessionWithClient(id) {
  const rows = await query(
    `SELECT s.id, s.starts_at, s.ends_at, s.status, s.manage_token, s.external_event_id, c.name, c.email
     FROM sessions s JOIN clients c ON c.id = s.client_id
     WHERE s.id = :id`,
    [longParam("id", id)],
  );
  return rows[0] || null;
}

async function approveRequest(id) {
  const row = await sessionWithClient(id);
  if (!row) return json(404, { ok: false, error: "Request not found." });
  if (row.status !== "pending") return json(400, { ok: false, error: "This request was already handled." });
  const updated = await query(
    `UPDATE sessions SET status = 'approved', decided_at = now(), updated_at = now()
     WHERE id = :id AND status = 'pending'
     RETURNING id`,
    [longParam("id", id)],
  );
  if (!updated.length) return json(400, { ok: false, error: "This request was already handled." });
  const mail = await sendMail(
    row.email,
    "Rachel will be in touch",
    `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111">
      <p>Hi ${esc(String(row.name).split(" ")[0])},</p>
      <p>Rachel will be in touch to schedule a time for a phone call.</p>
      <p style="margin-top:24px">Rachel<br/><span style="color:#888">Rising with Rachel</span></p>
    </div>`,
  );
  return json(200, { ok: true, ...mail });
}

async function declineRequest(id) {
  const row = await sessionWithClient(id);
  if (!row) return json(404, { ok: false, error: "Request not found." });
  if (row.status !== "pending") return json(400, { ok: false, error: "This request was already handled." });
  const updated = await query(
    `UPDATE sessions SET status = 'declined', decided_at = now(), updated_at = now()
     WHERE id = :id AND status = 'pending'
     RETURNING id`,
    [longParam("id", id)],
  );
  if (!updated.length) return json(400, { ok: false, error: "This request was already handled." });
  const mail = await sendMail(
    row.email,
    "Rachel can't take that request",
    `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111">
      <p>Hi ${esc(String(row.name).split(" ")[0])},</p>
      <p>Rachel isn't able to take your request.</p>
      <p style="margin-top:24px">Rachel<br/><span style="color:#888">Rising with Rachel</span></p>
    </div>`,
  );
  return json(200, { ok: true, ...mail });
}

async function createBlock(body, user) {
  const start = new Date(String(body.startsAt || ""));
  const end = new Date(String(body.endsAt || ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return json(400, { ok: false, error: "Enter a valid start and end." });
  }
  const rows = await query(
    `INSERT INTO availability_blocks (starts_at, ends_at, reason, created_by)
     VALUES (CAST(:starts AS timestamptz), CAST(:ends AS timestamptz), :reason, :created_by)
     RETURNING id, starts_at, ends_at, reason`,
    [
      textParam("starts", start.toISOString()),
      textParam("ends", end.toISOString()),
      textParam("reason", String(body.reason || "").trim().slice(0, 200)),
      textParam("created_by", user.email),
    ],
  );
  return json(200, { ok: true, block: rows[0] });
}

async function deleteBlock(id) {
  const rows = await query("DELETE FROM availability_blocks WHERE id = :id RETURNING id", [longParam("id", id)]);
  if (!rows.length) return json(400, { ok: false, error: "That block is already gone." });
  return json(200, { ok: true });
}

async function availabilitySettings() {
  const rule = await loadAvailability();
  const rows = await query("SELECT weekday, start_minute, end_minute, active FROM availability_rules ORDER BY weekday");
  const byDay = new Map(rows.map((row) => [Number(row.weekday), row]));
  const rules = WEEKDAY_NAMES.map((name, weekday) => {
    const row = byDay.get(weekday);
    return {
      weekday,
      name,
      active: row ? Boolean(row.active) : false,
      start_minute: row ? Number(row.start_minute) : 540,
      end_minute: row ? Number(row.end_minute) : 1020,
    };
  });
  return json(200, {
    ok: true,
    timezone: rule.timezone,
    timezoneLabel: `${zoneWord(rule.timezone)} Time`,
    slotMinutes: rule.slot_minutes,
    rules,
    availabilityLabel: availabilityLabel(rule),
  });
}

async function saveAvailabilityRules(body) {
  const rules = Array.isArray(body.rules) ? body.rules : [];
  for (const row of rules) {
    const weekday = Number(row.weekday);
    const startMinute = Number(row.start_minute);
    const endMinute = Number(row.end_minute);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return json(400, { ok: false, error: "Weekday is not valid." });
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 || endMinute <= startMinute) {
      return json(400, { ok: false, error: `${WEEKDAY_NAMES[weekday]} needs an end time after its start time.` });
    }
  }
  for (const row of rules) {
    await query(
      `INSERT INTO availability_rules (weekday, start_minute, end_minute, active)
       VALUES (:weekday, :start, :end, :active)
       ON CONFLICT (weekday) DO UPDATE
         SET start_minute = EXCLUDED.start_minute, end_minute = EXCLUDED.end_minute,
             active = EXCLUDED.active, updated_at = now()`,
      [
        longParam("weekday", row.weekday),
        longParam("start", row.start_minute),
        longParam("end", row.end_minute),
        boolParam("active", row.active),
      ],
    );
  }
  return availabilitySettings();
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method;
  const path = event?.requestContext?.http?.path || event?.rawPath || "";
  if (event?.source === "aws.events") {
    try {
      return { statusCode: 200, body: JSON.stringify(await sendReminders()) };
    } catch (err) {
      console.error("Reminders failed:", err);
      return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
  }

  if (method === "OPTIONS") return json(200, { ok: true });

  if (method === "POST" && path.endsWith("/stripe/webhook")) {
    try {
      return await stripeWebhook(event);
    } catch (err) {
      console.error("Stripe webhook failed:", err);
      return json(500, { ok: false, error: "Request failed" });
    }
  }

  const manageCancel = path.match(/\/session\/([A-Za-z0-9_-]+)\/cancel$/);
  const manageReschedule = path.match(/\/session\/([A-Za-z0-9_-]+)\/reschedule$/);
  const manageGet = path.match(/\/session\/([A-Za-z0-9_-]+)$/);
  if ((method === "POST" && manageCancel) || (method === "POST" && manageReschedule) || (method === "GET" && manageGet)) {
    let body = {};
    if (method === "POST") {
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
    }
    const token = (manageCancel || manageReschedule || manageGet)[1];
    const action = manageCancel ? "cancel" : manageReschedule ? "reschedule" : "get";
    try {
      return await manageSession(token, action, body);
    } catch (err) {
      console.error("Session link failed:", err);
      return json(500, { ok: false, error: "Request failed" });
    }
  }

  if (method === "GET" && path.endsWith("/api/availability")) {
    try {
      return json(200, { ok: true, ...(await calendarDays(false)) });
    } catch (err) {
      console.error("Availability failed:", err);
      return json(500, { ok: false, error: "Request failed" });
    }
  }

  if (method === "POST" && path.endsWith("/api/requests")) {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
    try {
      return await requestSlot(body);
    } catch (err) {
      console.error("Booking request failed:", err);
      return json(500, { ok: false, error: "Request failed" });
    }
  }

  if (method === "POST" && path.endsWith("/login")) {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
    return login(body);
  }

  const user = await requireUser(event);
  if (!user) return json(401, { ok: false, error: "Unauthorized" });

  const clientMatch = path.match(/\/clients\/(\d+)$/);
  const sessionCancel = path.match(/\/sessions\/(\d+)\/cancel$/);
  const sessionAccept = path.match(/\/sessions\/(\d+)\/accept$/);
  const sessionDeny = path.match(/\/sessions\/(\d+)\/deny$/);
  const blockMatch = path.match(/\/blocks\/(\d+)$/);

  try {
    if (method === "GET" && path.endsWith("/export")) return exportCsv();

    if (method === "GET" && path.endsWith("/calendar")) {
      return json(200, { ok: true, ...(await calendarDays(true)) });
    }

    if (method === "GET" && path.endsWith("/admin/availability")) return availabilitySettings();

    if (method === "PUT" && path.endsWith("/admin/availability")) {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
      return saveAvailabilityRules(body);
    }

    if (method === "POST" && path.endsWith("/blocks")) {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
      return createBlock(body, user);
    }

    if (method === "DELETE" && blockMatch) return deleteBlock(blockMatch[1]);

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
      const sessions = await query(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions WHERE client_id = :id AND status NOT IN ('cancelled', 'declined')
         ORDER BY starts_at`,
        [longParam("id", id)],
      );
      const rule = await loadAvailability();
      return json(200, {
        ok: true,
        client: clients[0],
        submissions,
        sessions,
        availabilityLabel: availabilityLabel(rule),
      });
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

    if (method === "POST" && path.endsWith("/sessions")) {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
      return bookSession(body, user);
    }

    if (method === "POST" && sessionCancel) {
      return cancelSession(sessionCancel[1]);
    }

    if (method === "POST" && sessionAccept) return approveRequest(sessionAccept[1]);

    if (method === "POST" && sessionDeny) return declineRequest(sessionDeny[1]);
  } catch (err) {
    console.error("Admin request failed:", err);
    return json(500, { ok: false, error: "Request failed" });
  }

  return json(404, { ok: false, error: "Not found" });
};
