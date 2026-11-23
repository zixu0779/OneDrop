import { afterEach, expect, test, vi } from "vitest";
const { exportLocal } = vi.hoisted(() => ({
  exportLocal: vi.fn(async () => ({ fileName: "file" })),
}));
vi.mock("@onedrop/native-runtime/native-download", () => ({
  legacyNativeDownload: { exportLocal },
}));
vi.mock("@onedrop/ui/OneDropApp", () => ({ App: () => null }));
import { exportBlob } from "@onedrop/native-runtime/export-local-file";
afterEach(() => vi.clearAllMocks());
test("exports a large legacy file in bounded chunks without touching its source", async () => {
  const bytes = new Uint8Array(1200000).fill(65);
  const source = new Blob([bytes]);
  await exportBlob("../original.txt", source);
  expect(exportLocal).toHaveBeenCalledTimes(3);
  const calls = exportLocal.mock.calls as unknown as [
    { base64: string; offset: number; exportId: string; complete: boolean },
  ][];
  expect(calls.map(([call]) => call.offset)).toEqual([0, 524288, 1048576]);
  expect(calls.map(([call]) => call.complete)).toEqual([false, false, true]);
  expect(new Set(calls.map(([call]) => call.exportId)).size).toBe(1);
  expect(calls.every(([call]) => call.base64.length <= 699052)).toBe(true);
  expect(calls.map(([call]) => atob(call.base64)).join("")).toBe(
    "A".repeat(bytes.length),
  );
  expect(source.size).toBe(bytes.length);
});
test("exports an empty file and reports failures without deleting the source", async () => {
  await exportBlob("empty.txt", new Blob([]));
  expect(exportLocal).toHaveBeenCalledWith(
    expect.objectContaining({ offset: 0, base64: "", complete: true }),
  );
  exportLocal.mockRejectedValueOnce(new Error("cancelled"));
  const source = new Blob(["kept"]);
  await expect(exportBlob("kept.txt", source)).rejects.toThrow("cancelled");
  expect(source.size).toBe(4);
});
