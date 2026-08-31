const REDACTED = "[redacted]";

export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function serializeForLog(value: unknown, secrets: readonly (string | undefined)[]): string {
  return redactSecrets(stringifyUnknown(value), secrets);
}

export function containsSecret(value: unknown, secrets: readonly (string | undefined)[]): boolean {
  const text = stringifyUnknown(value);
  return secrets.some((secret) => secret !== undefined && secret.length > 0 && text.includes(secret));
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return Object.prototype.toString.call(value);
  }
}
