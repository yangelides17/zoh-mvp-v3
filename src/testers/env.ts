import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { testers } from "../db/schema.js";
import { normalizeCommand } from "./commands.js";

/**
 * Staging and production (#82): one Sendblue line, two apps. Both get every webhook; each keeps only the
 * texts for numbers it owns. Testers always belong to production; a dev number belongs to the app its
 * saved route names (production until it texts "env staging").
 */

export const APP_ENVS = ["production", "staging"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Which app this is, and who the dev numbers are: enough to say who owns a number. */
export interface Routing {
  appEnv: AppEnv;
  devNumbers: string[];
}

/** Without routing (tests, the eval), this is production and owns every number, as before #82. */
export const PRODUCTION_ONLY: Routing = { appEnv: "production", devNumbers: [] };

/** The app a number belongs to: production, unless it's a dev number routed to staging. */
export function routeOf(routing: Routing, phone: string, route: AppEnv | null | undefined): AppEnv {
  return routing.devNumbers.includes(phone) ? (route ?? "production") : "production";
}

/** True when this app keeps and answers this number's texts and may start texts to it. */
export function owns(routing: Routing, phone: string, route: AppEnv | null | undefined): boolean {
  return routeOf(routing, phone, route) === routing.appEnv;
}

/** Looks the saved route up only when it can matter (a dev number); one read by phone. */
export async function ownsNumber(db: Db, routing: Routing, phone: string): Promise<boolean> {
  if (!routing.devNumbers.includes(phone)) return routing.appEnv === "production";
  const [row] = await db.select({ route: testers.route }).from(testers).where(eq(testers.phone, phone)).limit(1);
  return owns(routing, phone, row?.route);
}

/** What an "env" text asks for: which app you're on (`show`), or a switch. */
export type EnvCommand = { kind: "show" } | { kind: "switch"; to: AppEnv };

/** "env", "env staging", "env production" or "env prod", any case; anything else is ordinary text. */
export function parseEnv(text: string | null | undefined): EnvCommand | undefined {
  if (!text) return undefined;
  const words = normalizeCommand(text);
  if (words === "env") return { kind: "show" };
  if (words === "env staging") return { kind: "switch", to: "staging" };
  if (words === "env production" || words === "env prod") return { kind: "switch", to: "production" };
  return undefined;
}

/** The release and commit this app runs, for "env" and the console. */
export interface BuildInfo {
  /** package.json version, e.g. "0.3.0". */
  release?: string;
  /** Short commit, e.g. "a1b2c3d". */
  commit?: string;
}

/** "v0.3.0, a1b2c3d", or whichever half is known. */
export function versionLabel(build: BuildInfo = {}): string {
  return [build.release ? `v${build.release}` : undefined, build.commit].filter(Boolean).join(", ");
}

/** The reply to "env" and to a switch, from the app you're now on. */
export function envReply(appEnv: AppEnv, build: BuildInfo = {}): string {
  const version = versionLabel(build);
  return `You're on ${appEnv}${version ? ` (${version})` : ""}.`;
}
