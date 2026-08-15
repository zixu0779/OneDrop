import type { MonthReadResult } from "../src/contracts/runtime-messages";
import type { IosMonthTimeline } from "./onedrive";

export function iosDownloadId(driveItemId: string): number {
  let hash = 0;
  for (const character of driveItemId) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash || 1);
}

export function iosImageMetadata(input: {
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

export function iosTimelineResult(timeline: IosMonthTimeline): MonthReadResult {
  return {
    state: "loaded",
    month: timeline.month,
    eTag: "ios-native",
    messages: timeline.messages,
  };
}
