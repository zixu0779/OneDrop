import { oneDropDatabase } from "./database";

const UPLOAD_THROUGHPUT_KEY = "files.average-upload-throughput";
const MIN_SAMPLE_BYTES_PER_SECOND = 16 * 1024;
const MAX_SAMPLE_BYTES_PER_SECOND = 1024 * 1024 * 1024;

type UploadThroughputStats = {
  bytesPerSecond: number;
  sampleCount: number;
};

export async function getAverageUploadBytesPerSecond(): Promise<
  number | undefined
> {
  const value = (await oneDropDatabase.settings.get(UPLOAD_THROUGHPUT_KEY))
    ?.value;
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<UploadThroughputStats>;
    return typeof parsed.bytesPerSecond === "number" &&
      Number.isFinite(parsed.bytesPerSecond) &&
      parsed.bytesPerSecond > 0
      ? parsed.bytesPerSecond
      : undefined;
  } catch {
    return undefined;
  }
}

export async function recordUploadThroughput(
  uploadedBytes: number,
  durationMs: number,
): Promise<number | undefined> {
  if (uploadedBytes <= 0 || durationMs <= 0) {
    return getAverageUploadBytesPerSecond();
  }
  const sample = uploadedBytes / (durationMs / 1_000);
  if (
    !Number.isFinite(sample) ||
    sample < MIN_SAMPLE_BYTES_PER_SECOND ||
    sample > MAX_SAMPLE_BYTES_PER_SECOND
  ) {
    return getAverageUploadBytesPerSecond();
  }

  const existingValue = (
    await oneDropDatabase.settings.get(UPLOAD_THROUGHPUT_KEY)
  )?.value;
  let existing: UploadThroughputStats | undefined;
  if (existingValue) {
    try {
      const parsed = JSON.parse(existingValue) as UploadThroughputStats;
      if (
        Number.isFinite(parsed.bytesPerSecond) &&
        Number.isInteger(parsed.sampleCount) &&
        parsed.sampleCount > 0
      ) {
        existing = parsed;
      }
    } catch {
      // Replace malformed local statistics with the first valid sample.
    }
  }

  const sampleCount = (existing?.sampleCount ?? 0) + 1;
  const weight = sampleCount <= 5 ? 1 / sampleCount : 0.2;
  const bytesPerSecond = existing
    ? existing.bytesPerSecond * (1 - weight) + sample * weight
    : sample;
  await oneDropDatabase.settings.put({
    key: UPLOAD_THROUGHPUT_KEY,
    value: JSON.stringify({ bytesPerSecond, sampleCount }),
  });
  return bytesPerSecond;
}
