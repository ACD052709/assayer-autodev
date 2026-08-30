export function parseJsonArray<T>(value: string | null | undefined, fallback: readonly T[] = []): readonly T[] {
  if (!value) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return parsed as T[];
  } catch {
    return fallback;
  }
}

export function parseJsonObject<T extends Record<string, unknown>>(
  value: string | null | undefined,
): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

export function optionalNumber(value: number | null | undefined): number | undefined {
  return value ?? undefined;
}
