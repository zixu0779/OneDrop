type StoredValues = Record<string, unknown>;

export type OneDriveRuntime = {
  getAccessToken(): Promise<string>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  emit(message: unknown): Promise<void>;
};

let configuredRuntime: OneDriveRuntime | undefined;

export function setOneDriveRuntime(runtime: OneDriveRuntime): void {
  configuredRuntime = runtime;
}

export function getOneDriveRuntime(): OneDriveRuntime {
  if (configuredRuntime) return configuredRuntime;
  return {
    async getAccessToken() {
      const { getCurrentAccessToken } =
        await import("@onedrop/app-runtime/features/auth/auth-service");
      return getCurrentAccessToken();
    },
    storage: {
      async get(key) {
        return ((await browser.storage.local.get(key)) as StoredValues)[key];
      },
      async set(key, value) {
        await browser.storage.local.set({ [key]: value });
      },
      async remove(key) {
        await browser.storage.local.remove(key);
      },
    },
    async emit(message) {
      await browser.runtime.sendMessage(message);
    },
  };
}
