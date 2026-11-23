import {
  compareVersions,
  selectUpdate,
  validateUpdateAsset,
  type UpdateAdapter,
  type UpdateResult,
} from "@onedrop/core/domain/app-update";

export const UPDATE_FEED = "https://onedrop.sycamore.top/updates.json";
export type UpdateState = {
  busy?: "check" | "install" | undefined;
  result?: UpdateResult | undefined;
  error?: string | undefined;
  message?: string | undefined;
  progress?: number | undefined;
};
let adapter: UpdateAdapter | undefined;
let state: UpdateState = {};
let running: Promise<void> | undefined;
const listeners = new Set<() => void>();
export function configureUpdates(value: UpdateAdapter) {
  adapter = value;
  state = readState();
}
export function updateAdapter() {
  if (!adapter) throw new Error("Update checks are unavailable.");
  return adapter;
}
function key() {
  const a = updateAdapter();
  return `onedrop.updates.v1.${a.platform}.${a.channel}`;
}
function readState(): UpdateState {
  try {
    const saved = JSON.parse(localStorage.getItem(key()) ?? "{}");
    const result = saved.result as UpdateResult | undefined;
    if (result && !["current", "available"].includes(result.state))
      throw new Error();
    if (result?.state === "available") {
      if (
        !result.version ||
        compareVersions(result.version, updateAdapter().version) <= 0
      )
        return {};
      if (updateAdapter().platform !== "desktop-edge") {
        const asset = validateUpdateAsset(result.asset);
        if (
          asset.platform !== updateAdapter().platform ||
          asset.channel !== updateAdapter().channel ||
          asset.version !== result.version
        )
          throw new Error();
        result.asset = asset;
      }
    }
    return {
      result,
      error: typeof saved.error === "string" ? saved.error : undefined,
    };
  } catch {
    return {};
  }
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (adapter && event.key === key() && !state.busy) {
      state = readState();
      for (const listener of listeners) listener();
    }
  });
export function updateState() {
  return state;
}
export function subscribeUpdates(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(value: UpdateState, persist = true) {
  state = value;
  try {
    if (persist)
      localStorage.setItem(
        key(),
        JSON.stringify({ result: value.result, error: value.error }),
      );
  } catch {
    /* The current view can still show the result. */
  }
  for (const listener of listeners) listener();
}
export function localCalendarDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
// An IndexedDB read/write transaction serializes this claim across extension windows,
// including iOS versions without Web Locks. It is not an account database.
export async function claimUpdateDay(
  installation: string,
  day = localCalendarDate(),
): Promise<boolean> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("OneDropUpdates", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("days");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("days", "readwrite"),
      store = transaction.objectStore("days"),
      read = store.get(installation);
    let claimed = false;
    read.onsuccess = () => {
      if (read.result !== day) {
        store.put(day, installation);
        claimed = true;
      }
    };
    transaction.oncomplete = () => {
      db.close();
      resolve(claimed);
    };
    transaction.onerror = transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}
export function rememberStoreUpdate(version: string) {
  if (
    adapter?.platform !== "desktop-edge" ||
    compareVersions(version, adapter.version) <= 0
  )
    return;
  publish({ ...state, result: { state: "available", version } });
}
export function checkUpdates(manual = false): Promise<void> {
  if (state.busy === "install") return Promise.resolve();
  if (running) return running;
  running = (async () => {
    try {
      const claimed = await claimUpdateDay(key()).catch((error) => {
        if (manual) return true;
        throw error;
      });
      if (!claimed && !manual) {
        state = readState();
        for (const listener of listeners) listener();
        return;
      }
      publish({
        ...state,
        busy: "check",
        error: undefined,
        message: undefined,
      });
      const a = updateAdapter();
      let result: UpdateResult;
      if (a.checkStore) result = await a.checkStore();
      else {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(UPDATE_FEED, {
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error(
              "Update information could not be downloaded. Try again.",
            );
          const text = await response.text();
          if (text.length > 1024 * 1024)
            throw new Error("Update information is too large.");
          result = selectUpdate(JSON.parse(text), a);
        } finally {
          clearTimeout(timer);
        }
      }
      // A known browser-prepared update survives a later no_update/throttled response.
      if (
        a.platform === "desktop-edge" &&
        state.result?.state === "available" &&
        result.state === "current"
      )
        result = state.result;
      publish({ result });
    } catch (error) {
      publish({
        ...state,
        busy: undefined,
        error:
          error instanceof Error
            ? error.message
            : "Update check failed. Try again.",
      });
    }
  })().finally(() => {
    running = undefined;
  });
  return running;
}
export async function applyUpdate(): Promise<void> {
  if (state.busy) return;
  const result = state.result;
  if (result?.state !== "available") return;
  publish(
    { ...state, busy: "install", error: undefined, message: undefined },
    false,
  );
  try {
    const a = updateAdapter();
    const asset = result.asset ? validateUpdateAsset(result.asset) : undefined;
    if (
      asset &&
      (asset.platform !== a.platform ||
        asset.channel !== a.channel ||
        asset.version !== result.version ||
        compareVersions(asset.version, a.version) <= 0)
    )
      throw new Error(
        "Update information does not match this installation. Check again.",
      );
    if (!a.install && (!a.download || !asset))
      throw new Error("Updates cannot be opened on this installation.");
    const message = a.install
      ? await a.install(asset, (received, total) => {
          if (total > 0)
            publish(
              {
                ...state,
                progress: Math.min(100, Math.floor((received / total) * 100)),
              },
              false,
            );
        })
      : (await a.download?.(asset!.url),
        "Download opened. Complete installation manually.");
    publish(
      { ...readState(), busy: undefined, progress: undefined, message },
      false,
    );
  } catch (error) {
    publish(
      {
        ...readState(),
        busy: undefined,
        progress: undefined,
        error:
          error instanceof Error
            ? error.message
            : "The update could not be opened. Try again.",
      },
      false,
    );
  }
}
