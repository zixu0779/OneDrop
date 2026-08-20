import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import {
  accountSettingsSchema,
  defaultAccountSettings,
  defaultDeviceDisplayName,
  defaultDevicePreferences,
  deviceSettingsSchema,
  type AccountSettings,
  type DevicePlatform,
  type DeviceSettings,
  type SettingsSnapshot,
} from "@onedrop/core/domain/settings";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";
import { verifyAppFolderWithAccessToken } from "./app-folder";

const MAX_ATTEMPTS = 5;
const itemSchema = z.object({ id: z.string().min(1), eTag: z.string().min(1) });
const childrenSchema = z.object({
  value: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  "@odata.nextLink": z.string().url().optional(),
});

export type { SettingsSnapshot } from "@onedrop/core/domain/settings";

export async function readAccountSettingsWithAccessToken(
  accessToken: string,
): Promise<AccountSettings> {
  return (
    (await readDocument(
      "settings/account.json",
      accountSettingsSchema,
      accessToken,
    )) ?? defaultAccountSettings()
  );
}

export async function readSettingsWithAccessToken(
  accessToken: string,
  deviceId: string,
  platform: DevicePlatform,
  preferredDisplayName = defaultDeviceDisplayName(platform),
): Promise<SettingsSnapshot> {
  const now = new Date();
  const [account, device, devices] = await Promise.all([
    readDocument("settings/account.json", accountSettingsSchema, accessToken),
    readDocument(
      `settings/devices/${deviceId}.json`,
      deviceSettingsSchema,
      accessToken,
    ),
    listDeviceSettings(accessToken),
  ]);
  const uniqueDisplayName = nextAvailableDeviceName(
    preferredDisplayName,
    devices.filter((item) => item.deviceId !== deviceId),
  );
  let current =
    device ??
    deviceSettingsSchema.parse({
      schemaVersion: 1,
      deviceId,
      platform,
      displayName: uniqueDisplayName,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      preferences: defaultDevicePreferences(),
    });
  if (
    device &&
    ["This iPhone", "This Android device", "This Edge device"].includes(
      device.displayName,
    )
  ) {
    current = { ...device, displayName: uniqueDisplayName };
  }
  const resolvedAccount = account ?? defaultAccountSettings(now);
  await Promise.all([
    account
      ? Promise.resolve()
      : saveAccountSettingsWithAccessToken(accessToken, resolvedAccount),
    device && current.displayName === device.displayName
      ? Promise.resolve()
      : saveDeviceSettingsWithAccessToken(accessToken, current),
  ]);
  return {
    account: resolvedAccount,
    device: current,
    devices: [current, ...devices.filter((item) => item.deviceId !== deviceId)],
  };
}

function nextAvailableDeviceName(
  base: string,
  devices: DeviceSettings[],
): string {
  const names = new Set(devices.map((item) => item.displayName));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

export async function saveAccountSettingsWithAccessToken(
  accessToken: string,
  account: AccountSettings,
): Promise<AccountSettings> {
  await ensureSettingsFolders(accessToken);
  return writeDocument(
    "settings/account.json",
    accountSettingsSchema.parse(account),
    accountSettingsSchema,
    accessToken,
  );
}

export async function saveDeviceSettingsWithAccessToken(
  accessToken: string,
  device: DeviceSettings,
): Promise<DeviceSettings> {
  await ensureSettingsFolders(accessToken);
  return writeDocument(
    `settings/devices/${device.deviceId}.json`,
    deviceSettingsSchema.parse(device),
    deviceSettingsSchema,
    accessToken,
  );
}

export async function copyDevicePreferencesWithAccessToken(
  accessToken: string,
  current: DeviceSettings,
  sourceDeviceId: string,
): Promise<DeviceSettings> {
  const source = await readDocument(
    `settings/devices/${sourceDeviceId}.json`,
    deviceSettingsSchema,
    accessToken,
  );
  if (!source) throw new Error("The selected device settings no longer exist.");
  return saveDeviceSettingsWithAccessToken(accessToken, {
    ...current,
    lastSeenAt: new Date().toISOString(),
    preferences: source.preferences,
  });
}

export function resetDevicePreferences(device: DeviceSettings): DeviceSettings {
  return {
    ...device,
    lastSeenAt: new Date().toISOString(),
    preferences: defaultDevicePreferences(),
  };
}

async function listDeviceSettings(
  accessToken: string,
): Promise<DeviceSettings[]> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/settings/devices:/children?$select=id,name&$top=200`;
  const devices: DeviceSettings[] = [];
  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(
        `Settings could not be listed: ${await readGraphError(response)}`,
      );
    }
    const page = childrenSchema.parse(await response.json());
    for (const item of page.value) {
      if (!/^[0-9a-f-]{36}\.json$/iu.test(item.name)) continue;
      const content = await fetch(
        `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!content.ok) continue;
      const parsed = deviceSettingsSchema.safeParse(await content.json());
      if (parsed.success) devices.push(parsed.data);
    }
    url = page["@odata.nextLink"];
    if (url && !url.startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
      throw new Error("OneDrive returned an invalid settings pagination URL.");
    }
  }
  return devices.sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt),
  );
}

async function readDocument<T>(
  path: string,
  schema: z.ZodType<T>,
  accessToken: string,
): Promise<T | undefined> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/${path}:/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Settings could not be read: ${await readGraphError(response)}`,
    );
  }
  return schema.parse(await response.json());
}

async function writeDocument<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
  accessToken: string,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const metadata = await fetch(
      `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/${path}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (metadata.status !== 404 && !metadata.ok) {
      throw new Error(
        `Settings lookup failed: ${await readGraphError(metadata)}`,
      );
    }
    const existing =
      metadata.status === 404
        ? undefined
        : itemSchema.parse(await metadata.json());
    const conflictBehavior = encodeURIComponent(
      "@microsoft.graph.conflictBehavior",
    );
    const response = existing
      ? await fetch(
          `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(existing.id)}/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json; charset=utf-8",
              "If-Match": existing.eTag,
            },
            body: JSON.stringify(value, null, 2),
          },
        )
      : await fetch(
          `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/${path}:/content?${conflictBehavior}=fail`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(value, null, 2),
          },
        );
    if (response.status === 409 || response.status === 412) continue;
    if (!response.ok) {
      throw new Error(
        `Settings could not be saved: ${await readGraphError(response)}`,
      );
    }
    return schema.parse(value);
  }
  throw new Error("Settings changed repeatedly. Try again.");
}

async function ensureSettingsFolders(accessToken: string): Promise<void> {
  const appRoot = await verifyAppFolderWithAccessToken(accessToken);
  const settingsId = await ensureFolder(accessToken, appRoot.id, "settings");
  await ensureFolder(accessToken, settingsId, "devices");
}

async function ensureFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<string> {
  const lookup = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (lookup.ok)
    return z.object({ id: z.string().min(1) }).parse(await lookup.json()).id;
  if (lookup.status !== 404) {
    throw new Error(
      `Settings folder lookup failed: ${await readGraphError(lookup)}`,
    );
  }
  const created = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  if (created.status === 409) return ensureFolder(accessToken, parentId, name);
  if (!created.ok) {
    throw new Error(
      `Settings folder creation failed: ${await readGraphError(created)}`,
    );
  }
  return z.object({ id: z.string().min(1) }).parse(await created.json()).id;
}
