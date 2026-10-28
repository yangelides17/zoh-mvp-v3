import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Founder console login (spec: GitHub issue "Founder console", rule 5): one shared password gives a
 * signed cookie good for 30 days. The founder's name is picked once per device and rides in the same
 * cookie, so every decision is stored with who made it.
 */

export const SESSION_COOKIE = "zoh_console";
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;

export interface Session {
  /** Ms since epoch. */
  exp: number;
  /** Unset until they pick their name on this device. */
  name?: string;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function newSession(now: Date, name?: string): Session {
  return { exp: now.getTime() + SESSION_MS, ...(name ? { name } : {}) };
}

export function encodeSession(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The session in a cookie value, if it's ours, untampered and not expired. */
export function decodeSession(value: string | undefined, secret: string, now: Date): Session | undefined {
  if (!value) return undefined;
  const dot = value.indexOf(".");
  if (dot <= 0) return undefined;
  const payload = value.slice(0, dot);
  if (!sameText(value.slice(dot + 1), sign(payload, secret))) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Session>;
    if (typeof parsed.exp !== "number" || parsed.exp <= now.getTime()) return undefined;
    return { exp: parsed.exp, ...(typeof parsed.name === "string" ? { name: parsed.name } : {}) };
  } catch {
    return undefined;
  }
}

export function passwordMatches(given: unknown, expected: string): boolean {
  return typeof given === "string" && sameText(given, expected);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Cookie header → name/value pairs. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed cookie is just ignored.
    }
  }
  return out;
}

export function sessionCookie(value: string, maxAgeSeconds = SESSION_MS / 1000): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/console; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/console; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
