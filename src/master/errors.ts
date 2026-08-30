export class MasterModelConfigError extends Error {
  readonly code = "openai_misconfigured";

  constructor(message = "OPENAI_API_KEY is not configured") {
    super(message);
    this.name = "MasterModelConfigError";
  }
}

export class MasterModelRequestError extends Error {
  readonly code = "openai_request_failed";

  constructor(message: string) {
    super(message);
    this.name = "MasterModelRequestError";
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9_-]+/g,
  /Bearer\s+\S+/gi,
  /OPENAI_API_KEY\s*[:=]\s*\S+/gi,
];

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof MasterModelConfigError || error instanceof MasterModelRequestError) {
    return redactSecrets(error.message);
  }
  if (error instanceof Error) {
    return redactSecrets(error.message || "model_request_failed");
  }
  return "model_request_failed";
}

export function toSafeModelError(error: unknown): Error {
  if (error instanceof MasterModelConfigError) {
    return new MasterModelConfigError(redactSecrets(error.message));
  }
  return new MasterModelRequestError(sanitizeErrorMessage(error));
}
