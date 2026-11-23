import { oneDropConfig } from "@onedrop/core/config/onedrop";

// Graph /content redirects fail in some WebViews. Its metadata download URL
// is preauthenticated and must be fetched without the Graph bearer token.
export async function readGraphContent(
  itemUrl: string,
  accessToken: string,
): Promise<Response> {
  if (!itemUrl.startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
    throw new Error("Invalid OneDrive metadata URL.");
  }
  const metadata = await fetch(itemUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metadata.ok) return metadata;
  const item: unknown = await metadata.json();
  const downloadUrl =
    typeof item === "object" && item !== null
      ? (item as Record<string, unknown>)["@microsoft.graph.downloadUrl"]
      : undefined;
  let url: URL;
  try {
    if (typeof downloadUrl !== "string") throw new Error();
    url = new URL(downloadUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error();
  } catch {
    throw new Error("OneDrive did not provide a valid download URL.");
  }
  return fetch(url.href, { credentials: "omit" });
}
