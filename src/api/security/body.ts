import { ApiError } from "../errors.js";

export function assertValidContentLength(request: Request, maxBytes: number): void {
  const header = request.headers.get("content-length");
  if (header === null) {
    return;
  }
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_content_length", "Invalid Content-Length header");
  }
  if (parsed > maxBytes) {
    throw new ApiError(413, "payload_too_large", "Request body too large");
  }
}

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  assertValidContentLength(request, maxBytes);
  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw new ApiError(413, "payload_too_large", "Request body too large");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  const bytes = await readBodyBytes(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "validation_error", "Invalid body", [
      { field: "body", message: "Must be an object" },
    ]);
  }
  return parsed as Record<string, unknown>;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+(?:=[A-Za-z0-9+/]*={0,2})?$/;

/**
 * Decode a bootstrap base64 blob with strict validation and a decoded-size cap.
 * Temporary path for small test blobs only.
 */
export function decodeBootstrapBase64(value: string, maxDecodedBytes: number): Uint8Array {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ApiError(400, "validation_error", "Invalid blobBase64", [
      { field: "blobBase64", message: "Must be non-empty base64" },
    ]);
  }
  if (normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new ApiError(400, "validation_error", "Invalid blobBase64", [
      { field: "blobBase64", message: "Malformed base64" },
    ]);
  }

  let bytes: Uint8Array;
  try {
    if (typeof atob === "function") {
      const binary = atob(normalized);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    } else {
      const buf = Buffer.from(normalized, "base64");
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  } catch {
    throw new ApiError(400, "validation_error", "Invalid blobBase64", [
      { field: "blobBase64", message: "Malformed base64" },
    ]);
  }

  if (bytes.byteLength > maxDecodedBytes) {
    throw new ApiError(413, "payload_too_large", "Decoded evidence blob exceeds bootstrap limit");
  }
  return bytes;
}
