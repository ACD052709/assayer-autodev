export class WorkerRunLifecycleError extends Error {
  readonly code: "not_found" | "conflict" | "inconsistent" | "illegal_transition" | "validation";

  constructor(
    code: "not_found" | "conflict" | "inconsistent" | "illegal_transition" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "WorkerRunLifecycleError";
    this.code = code;
  }
}
