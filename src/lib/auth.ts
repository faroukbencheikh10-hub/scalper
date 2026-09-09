// Sessione dashboard firmata HMAC. Usa solo Web Crypto: gira sia nel middleware
// (runtime Edge) sia nelle route handler (runtime Node).

export const DASHBOARD_COOKIE = "scalper_dashboard";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const SESSION_PREFIX = "scalper-dashboard|";

const encoder = new TextEncoder();

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Valore del cookie: `<scadenza ms>.<hmac>`. */
export async function createSessionCookie(secret: string, expiresAtMs: number) {
  return `${expiresAtMs}.${await hmacHex(secret, `${SESSION_PREFIX}${expiresAtMs}`)}`;
}

export async function verifySessionCookie(value: string | undefined | null, secret: string) {
  if (!value) return false;
  const separator = value.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(value.slice(0, separator));
  const signature = value.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || !signature) return false;
  if (expiresAt <= Date.now()) return false;
  return constantTimeEqual(signature, await hmacHex(secret, `${SESSION_PREFIX}${expiresAt}`));
}

/** Confronto della password a tempo costante: entrambi i lati passano da un digest. */
export async function passwordMatches(candidate: string, secret: string) {
  const [a, b] = await Promise.all([hmacHex(secret, `password|${candidate}`), hmacHex(secret, `password|${secret}`)]);
  return constantTimeEqual(a, b);
}
