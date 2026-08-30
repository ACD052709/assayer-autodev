/** Maximum JSON request body for control-plane metadata endpoints. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/** Maximum decoded bootstrap evidence blob via JSON base64 (temporary path). */
export const MAX_BOOTSTRAP_BLOB_BYTES = 64 * 1024;

/** Evidence JSON uses the same metadata limit; blob field validated separately. */
export const MAX_EVIDENCE_JSON_BODY_BYTES = MAX_JSON_BODY_BYTES;

/**
 * Temporary bootstrap only — production evidence should upload directly to controlled R2 paths.
 * @see README security section
 */
export const BOOTSTRAP_BLOB_FIELD = "blobBase64";
