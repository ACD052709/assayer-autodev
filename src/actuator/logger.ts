import { containsSecret, redactSecrets } from "./sanitize.js";
import type { ActuatorLogger } from "./types.js";

export function createSanitizingLogger(
  secrets: readonly (string | undefined)[],
  sink: ActuatorLogger = consoleLogger,
): ActuatorLogger {
  return {
    info(message, fields) {
      sink.info(redactSecrets(message, secrets), redactFields(fields, secrets));
    },
    error(message, fields) {
      sink.error(redactSecrets(message, secrets), redactFields(fields, secrets));
    },
  };
}

export const consoleLogger: ActuatorLogger = {
  info(message, fields) {
    if (fields === undefined) {
      console.info(message);
      return;
    }
    console.info(message, fields);
  },
  error(message, fields) {
    if (fields === undefined) {
      console.error(message);
      return;
    }
    console.error(message, fields);
  },
};

function redactFields(
  fields: Record<string, unknown> | undefined,
  secrets: readonly (string | undefined)[],
): Record<string, unknown> | undefined {
  if (fields === undefined) {
    return undefined;
  }
  if (containsSecret(fields, secrets)) {
    return { redacted: true };
  }
  return fields;
}
