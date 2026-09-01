import { createHash } from "node:crypto";

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyPatchChecksum(
  patchContent: string | Uint8Array,
  expectedChecksumSha256: string,
): boolean {
  return sha256Hex(patchContent) === expectedChecksumSha256.toLowerCase();
}
