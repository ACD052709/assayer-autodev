export class WorkerRunLifecycleError extends Error {
  readonly code:
    | "not_found"
    | "conflict"
    | "inconsistent"
    | "illegal_transition"
    | "validation"
    | "unauthorized"
    | "expired";

  constructor(
    code:
      | "not_found"
      | "conflict"
      | "inconsistent"
      | "illegal_transition"
      | "validation"
      | "unauthorized"
      | "expired",
    message: string,
  ) {
    super(message);
    this.name = "WorkerRunLifecycleError";
    this.code = code;
  }
}
