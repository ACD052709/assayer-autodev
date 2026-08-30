import type { EvidenceBlobStore } from "./blob-store.js";

export class InMemoryEvidenceBlobStore implements EvidenceBlobStore {
  private readonly blobs = new Map<string, { data: Uint8Array; contentType?: string }>();

  async put(key: string, data: ArrayBuffer | Uint8Array, contentType?: string): Promise<{ key: string }> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.blobs.set(key, {
      data: bytes,
      ...(contentType !== undefined ? { contentType } : {}),
    });
    return { key };
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const entry = this.blobs.get(key);
    if (!entry) {
      return null;
    }
    return entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) as ArrayBuffer;
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }
}
