import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";

const childrenPageSchema = z.object({
  value: z.array(
    z.object({
      name: z.string(),
      folder: z.object({}).optional(),
    }),
  ),
  "@odata.nextLink": z.string().url().optional(),
});

export async function listMonthEntries(
  directory: "messages" | "archive",
  accessToken: string,
): Promise<string[]> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/${directory}:/children?$select=name,folder&$top=200`;
  const months: string[] = [];
  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) break;
    if (!response.ok) throw new Error(await readGraphError(response));
    const page = childrenPageSchema.parse(await response.json());
    for (const item of page.value) {
      if (directory === "messages") {
        if (item.folder && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(item.name))
          months.push(item.name);
      } else if (
        !item.folder &&
        /^\d{4}-(?:0[1-9]|1[0-2])\.json$/u.test(item.name)
      ) {
        months.push(item.name.slice(0, 7));
      }
    }
    url = page["@odata.nextLink"];
    if (url && !url.startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
      throw new Error("OneDrive returned an invalid month pagination URL.");
    }
  }
  return months.sort().reverse();
}

export async function listHistoryMonths(
  accessToken: string,
): Promise<string[]> {
  const [sources, archives] = await Promise.all([
    listMonthEntries("messages", accessToken),
    listMonthEntries("archive", accessToken),
  ]);
  return [...new Set([...sources, ...archives])].sort().reverse();
}
