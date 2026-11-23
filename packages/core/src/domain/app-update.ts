export type UpdatePlatform = "desktop-edge" | "mobile-edge" | "android" | "ios";
export type UpdateChannel = "stable" | "beta";
export type UpdateAsset = {
  platform: UpdatePlatform;
  channel: UpdateChannel;
  version: string;
  url: string;
  size: number;
  sha256: string;
};
export type UpdateResult = {
  state: "current" | "available";
  version?: string;
  asset?: UpdateAsset;
};
export interface UpdateAdapter {
  platform: UpdatePlatform;
  channel: UpdateChannel;
  version: string;
  checkStore?(): Promise<UpdateResult>;
  install?(
    asset?: UpdateAsset,
    onProgress?: (received: number, total: number) => void,
  ): Promise<string>;
  download?(url: string): Promise<void>;
}
export function versionParts(version: string): number[] {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(
      version,
    )
  )
    throw new Error("Invalid update version.");
  const parts = version.split(".").map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n) || n > 999999))
    throw new Error("Invalid update version.");
  return parts;
}
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a),
    right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
export function validateUpdateAsset(value: unknown): UpdateAsset {
  if (!value || typeof value !== "object")
    throw new Error("Invalid update metadata.");
  const a = value as UpdateAsset;
  versionParts(a.version);
  if (
    !["mobile-edge", "android", "ios"].includes(a.platform) ||
    !["stable", "beta"].includes(a.channel) ||
    (a.channel === "beta" && a.platform !== "ios") ||
    !Number.isSafeInteger(a.size) ||
    a.size <= 0 ||
    a.size > 256 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(a.sha256)
  )
    throw new Error("Invalid update metadata.");
  const tag = a.channel === "beta" ? `ios-beta-v${a.version}` : `v${a.version}`;
  const name =
    a.platform === "ios"
      ? `OneDrop-${a.channel === "beta" ? "Beta-" : ""}${a.version}.ipa`
      : `OneDrop-${a.version}-${a.platform === "android" ? "android.apk" : "mobile-edge.crx"}`;
  if (
    a.url !==
    `https://github.com/zixu0779/OneDrop/releases/download/${tag}/${name}`
  )
    throw new Error("The update is not an official OneDrop release.");
  return {
    platform: a.platform,
    channel: a.channel,
    version: a.version,
    url: a.url,
    size: a.size,
    sha256: a.sha256,
  };
}
export function selectUpdate(
  feed: unknown,
  adapter: Pick<UpdateAdapter, "platform" | "channel" | "version">,
): UpdateResult {
  if (
    !feed ||
    typeof feed !== "object" ||
    (feed as { schemaVersion?: number }).schemaVersion !== 1 ||
    !Array.isArray((feed as { assets?: unknown }).assets)
  )
    throw new Error("Update information is unavailable.");
  const assets = (feed as { assets: unknown[] }).assets
    .filter(
      (value) =>
        value &&
        typeof value === "object" &&
        (value as UpdateAsset).platform === adapter.platform &&
        (value as UpdateAsset).channel === adapter.channel,
    )
    .map(validateUpdateAsset)
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = assets[0];
  if (!newest)
    throw new Error(
      "No update information is available for this installation.",
    );
  return compareVersions(newest.version, adapter.version) > 0
    ? { state: "available", version: newest.version, asset: newest }
    : { state: "current" };
}
