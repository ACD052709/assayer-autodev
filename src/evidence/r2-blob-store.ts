import type { R2Bucket } from "@cloudflare/workers-types";
import type { EvidenceBlobStore } from "./blob-store.js";

export class R2EvidenceBlobStore implements EvidenceBlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, data: ArrayBuffer | Uint8Array, contentType?: string): Promise<{ key: string }> {
    await this.bucket.put(key, data, {
      ...(contentType !== undefined ? { httpMetadata: { contentType } } : {}),
    });
    return { key };
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }
    return object.arrayBuffer();
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.bucket.head(key);
    return head !== null;
  }
}
