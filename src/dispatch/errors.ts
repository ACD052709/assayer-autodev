export class DispatchValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "DispatchValidationError";
    this.field = field;
  }
}

export class WorkerReportValidationError extends Error {
  readonly code: "not_found" | "conflict" | "mismatch";

  constructor(code: "not_found" | "conflict" | "mismatch", message: string) {
    super(message);
    this.name = "WorkerReportValidationError";
    this.code = code;
  }
}
