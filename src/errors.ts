/**
 * Error details that are safe to log. Database errors from Drizzle embed the full query
 * parameters (phone numbers, message text) in their message; this keeps only the cause.
 */
export interface SafeError {
  name: string;
  message: string;
  code?: string;
}

export function safeError(err: unknown): SafeError {
  if (!(err instanceof Error)) return { name: "NonError", message: String(err).slice(0, 300) };
  const cause = (err as { cause?: unknown }).cause;
  const source = cause instanceof Error ? cause : err;
  const code = (source as { code?: unknown }).code;
  const firstLine = source.message.split("\nparams:")[0] ?? source.message;
  const message = source === err && /^Failed query:/.test(firstLine) ? "Database query failed" : firstLine;
  return {
    name: err.name,
    message: message.slice(0, 300),
    ...(typeof code === "string" ? { code } : {}),
  };
}
