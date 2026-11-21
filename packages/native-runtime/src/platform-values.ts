import type { MonthReadResult } from "@onedrop/core/contracts/runtime-messages";
import type { NativeMonthTimeline } from "./onedrive";

export function nativeDownloadId(driveItemId: string): number {
  let hash = 0;
  for (const character of driveItemId) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash || 1);
}

export function nativeImageMetadata(input: {
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
}): { imageWidth?: number; imageHeight?: number; thumbHash?: string } {
  return {
    ...(input.imageWidth ? { imageWidth: input.imageWidth } : {}),
    ...(input.imageHeight ? { imageHeight: input.imageHeight } : {}),
    ...(input.thumbHash ? { thumbHash: input.thumbHash } : {}),
  };
}

export function nativeTimelineResult(
  timeline: NativeMonthTimeline,
): MonthReadResult {
  return {
    state: "loaded",
    month: timeline.month,
    eTag: "native",
    messages: timeline.messages,
  };
}
