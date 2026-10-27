import { z } from "zod";

/** Treat empty strings (common for unset Railway variables) as missing. */
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().optional(),
);

const withDefault = (fallback: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().default(fallback),
  );

const intWithDefault = (fallback: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().default(fallback),
  );

const boolWithDefault = (fallback: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .enum(["true", "false", "1", "0"])
      .default(fallback ? "true" : "false")
      .transform((v) => v === "true" || v === "1"),
  );

const phoneList = z.preprocess(
  (v) => (typeof v === "string" ? v : ""),
  z.string().transform((s) =>
    s
      .split(",")
      .map((p) => normalizePhone(p))
      .filter((p) => p.length > 0),
  ),
);

const envSchema = z.object({
  PORT: intWithDefault(3000),
  HOST: withDefault("::"),
  LOG_LEVEL: withDefault("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  SENDBLUE_BASE_URL: withDefault("https://api.sendblue.com"),
  SENDBLUE_API_KEY_ID: optionalString,
  SENDBLUE_API_KEY_SECRET: optionalString,
  SENDBLUE_NUMBER: optionalString,
  SENDBLUE_WEBHOOK_SECRET: optionalString,
  TYPING_INDICATOR: boolWithDefault(true),

  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: withDefault("claude-sonnet-5-5"),
  CLAUDE_MAX_TOKENS: intWithDefault(400),
  CLAUDE_HISTORY_LIMIT: intWithDefault(12),

  /** Comma-separated E.164 numbers that get replies while we build. */
  ALLOWED_NUMBERS: phoneList,
  /** Comma-separated E.164 dev accounts (test users who can text "reset"). */
  DEV_NUMBERS: phoneList,

  BUCKET_ENDPOINT: optionalString,
  BUCKET_NAME: optionalString,
  BUCKET_REGION: withDefault("auto"),
  BUCKET_ACCESS_KEY_ID: optionalString,
  BUCKET_SECRET_ACCESS_KEY: optionalString,
  BUCKET_FORCE_PATH_STYLE: boolWithDefault(false),

  SPEACHES_URL: optionalString,
  SPEACHES_API_KEY: optionalString,
  SPEACHES_MODEL: withDefault("Systran/faster-distil-whisper-small.en"),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string;
  allowedNumbers: string[];
  devNumbers: string[];
  typingIndicator: boolean;
  sendblue: {
    baseUrl: string;
    apiKeyId?: string;
    apiKeySecret?: string;
    number?: string;
    webhookSecret?: string;
  };
  claude: {
    apiKey?: string;
    model: string;
    maxTokens: number;
    historyLimit: number;
  };
  bucket: {
    endpoint?: string;
    name?: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
  speaches: {
    url?: string;
    apiKey?: string;
    model: string;
  };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    allowedNumbers: e.ALLOWED_NUMBERS,
    devNumbers: e.DEV_NUMBERS,
    typingIndicator: e.TYPING_INDICATOR,
    sendblue: {
      baseUrl: e.SENDBLUE_BASE_URL.replace(/\/+$/, ""),
      apiKeyId: e.SENDBLUE_API_KEY_ID,
      apiKeySecret: e.SENDBLUE_API_KEY_SECRET,
      number: e.SENDBLUE_NUMBER ? normalizePhone(e.SENDBLUE_NUMBER) : undefined,
      webhookSecret: e.SENDBLUE_WEBHOOK_SECRET,
    },
    claude: {
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.CLAUDE_MODEL,
      maxTokens: e.CLAUDE_MAX_TOKENS,
      historyLimit: e.CLAUDE_HISTORY_LIMIT,
    },
    bucket: {
      endpoint: e.BUCKET_ENDPOINT,
      name: e.BUCKET_NAME,
      region: e.BUCKET_REGION,
      accessKeyId: e.BUCKET_ACCESS_KEY_ID,
      secretAccessKey: e.BUCKET_SECRET_ACCESS_KEY,
      forcePathStyle: e.BUCKET_FORCE_PATH_STYLE,
    },
    speaches: {
      url: e.SPEACHES_URL?.replace(/\/+$/, ""),
      apiKey: e.SPEACHES_API_KEY,
      model: e.SPEACHES_MODEL,
    },
  };
}

/** Keep digits and a leading "+"; Sendblue already sends E.164. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  return trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** Names of settings that are still missing, for /health and startup logs. Never values. */
export function missingSettings(config: Config): string[] {
  const missing: string[] = [];
  if (!config.sendblue.apiKeyId) missing.push("SENDBLUE_API_KEY_ID");
  if (!config.sendblue.apiKeySecret) missing.push("SENDBLUE_API_KEY_SECRET");
  if (!config.sendblue.number) missing.push("SENDBLUE_NUMBER");
  if (!config.sendblue.webhookSecret) missing.push("SENDBLUE_WEBHOOK_SECRET");
  if (!config.claude.apiKey) missing.push("ANTHROPIC_API_KEY");
  if (config.allowedNumbers.length === 0) missing.push("ALLOWED_NUMBERS");
  if (!config.bucket.endpoint || !config.bucket.name || !config.bucket.accessKeyId || !config.bucket.secretAccessKey) {
    missing.push("BUCKET_*");
  }
  if (!config.speaches.url) missing.push("SPEACHES_URL");
  return missing;
}
