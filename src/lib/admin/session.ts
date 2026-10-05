import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Minimal /admin session: one shared password (ADMIN_PASSWORD) and an
// httpOnly cookie holding "<expiresAt>.<hmac>". The HMAC key is derived from
// the password, so changing ADMIN_PASSWORD logs everyone out. No password set
// = nobody gets in.
//
// Pure (no next/headers) so both src/proxy.ts and the server actions use it.

export const ADMIN_COOKIE = "twte_admin";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;

function key(password: string): Buffer {
  return createHash("sha256").update(`twte-admin-session:${password}`).digest();
}

function sign(expiresAt: number, password: string): string {
  return createHmac("sha256", key(password)).update(String(expiresAt)).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function adminPassword(): string | undefined {
  const password = process.env.ADMIN_PASSWORD;
  return password && password.length > 0 ? password : undefined;
}

export function checkPassword(attempt: string): boolean {
  const password = adminPassword();
  return !!password && safeEqual(attempt, password);
}

export function createSessionToken(now = Date.now()): string {
  const password = adminPassword();
  if (!password) throw new Error("ADMIN_PASSWORD is not set");
  const expiresAt = now + ADMIN_SESSION_SECONDS * 1000;
  return `${expiresAt}.${sign(expiresAt, password)}`;
}

export function isValidSessionToken(token: string | undefined, now = Date.now()): boolean {
  const password = adminPassword();
  if (!password || !token) return false;
  const [expires, signature] = token.split(".");
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || !signature) return false;
  return safeEqual(signature, sign(expiresAt, password));
}
