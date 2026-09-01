export class BrowserVerifierError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserVerifierError";
    this.code = code;
  }
}
