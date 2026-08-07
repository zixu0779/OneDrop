import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateDeviceId } from "../../src/features/device/device-service";

describe("device identity", () => {
  const state: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(state)) delete state[key];
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: state[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(state, values);
          }),
        },
      },
    });
  });

  it("persists one stable ID for the Edge installation", async () => {
    const first = await getOrCreateDeviceId();
    const second = await getOrCreateDeviceId();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
