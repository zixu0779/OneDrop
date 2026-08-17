import { z } from "zod";

const DEVICE_ID_KEY = "onedrop.device.id";

export async function getOrCreateDeviceId(): Promise<string> {
  const stored = await browser.storage.local.get(DEVICE_ID_KEY);
  const parsed = z.uuid().safeParse(stored[DEVICE_ID_KEY]);
  if (parsed.success) return parsed.data;

  const deviceId = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_ID_KEY]: deviceId });
  return deviceId;
}
