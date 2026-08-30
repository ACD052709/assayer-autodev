import { logServerError } from "./auth/token.js";
import { applySecurityHeaders } from "./security/headers.js";

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly { readonly field: string; readonly message: string }[];
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly { readonly field: string; readonly message: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  toResponse(): Response {
    return jsonResponse(this.toBody(), this.status);
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function handleApiError(error: unknown, production = false): Response {
  if (error instanceof ApiError) {
    return error.toResponse();
  }

  logServerError("api", error);

  void production;
  return new ApiError(500, "internal_error", "An internal error occurred").toResponse();
}

export function finalizeResponse(response: Response, production: boolean, error?: unknown): Response {
  if (error !== undefined) {
    return applySecurityHeaders(handleApiError(error, production));
  }
  return applySecurityHeaders(response);
}
