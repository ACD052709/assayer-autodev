import { redactSecrets } from "./sanitize.js";

export class ActuatorError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly ownershipLost: boolean;

  constructor(
    code: string,
    message: string,
    options?: { readonly status?: number; readonly ownershipLost?: boolean },
  ) {
    super(message);
    this.name = "ActuatorError";
    this.code = code;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
    this.ownershipLost = options?.ownershipLost === true;
  }
}

export function sanitizeActuatorError(
  error: unknown,
  secrets: readonly (string | undefined)[],
): ActuatorError {
  if (error instanceof ActuatorError) {
    return new ActuatorError(error.code, redactSecrets(error.message, secrets), {
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.ownershipLost ? { ownershipLost: true } : {}),
    });
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Actuator error";
  return new ActuatorError("ACTUATOR_ERROR", redactSecrets(message, secrets));
}

export function isOwnershipLostStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 409;
}
