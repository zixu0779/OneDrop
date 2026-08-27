export type EdgeRuntimePlatform = "desktop" | "android" | "ios";

export function detectEdgeRuntimePlatform(
  userAgent: string,
  operatingSystem?: string,
): EdgeRuntimePlatform {
  if (/EdgiOS|iPhone|iPad|iPod/iu.test(userAgent)) return "ios";
  if (operatingSystem === "android" || /Android|EdgA/iu.test(userAgent)) {
    return "android";
  }
  return "desktop";
}
