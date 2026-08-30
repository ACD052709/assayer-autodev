export interface EvidenceBlobRef {
  readonly key: string;
}

export interface EvidenceBlobStore {
  put(key: string, data: ArrayBuffer | Uint8Array, contentType?: string): Promise<EvidenceBlobRef>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export function evidenceBlobKey(projectId: string, evidenceId: string): string {
  return `${projectId}/evidence/${evidenceId}`;
}
