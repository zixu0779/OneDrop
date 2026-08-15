export const MAX_DIRECT_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPLOAD_BYTES_PER_SECOND = 1024 * 1024;
export const MIN_UPLOAD_SESSION_BYTES = 320 * 1024;
export const MEDIUM_UPLOAD_CHUNK_BYTES = 640 * 1024;
export const MINIMUM_UPLOAD_CHUNK_BYTES = 320 * 1024;
export const LARGE_FILE_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

export function shouldUseUploadSession(input: {
  size: number;
  mimeType: string;
}): boolean {
  return input.size >= MIN_UPLOAD_SESSION_BYTES;
}

export function getUploadChunkBytes(input: {
  size: number;
  mimeType: string;
}): number {
  if (
    input.size > MAX_DIRECT_FILE_BYTES &&
    !input.mimeType.startsWith("image/")
  ) {
    return LARGE_FILE_UPLOAD_CHUNK_BYTES;
  }
  return input.size >= 1024 * 1024
    ? MEDIUM_UPLOAD_CHUNK_BYTES
    : MINIMUM_UPLOAD_CHUNK_BYTES;
}
