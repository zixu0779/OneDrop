import { File as NodeFile } from "node:buffer";
import { afterEach, expect, test, vi } from "vitest";
import { prepareAccountAvatar } from "../../packages/ui/src/account-avatar-image";
const jpeg = [255, 216, 255, 0];
function file(bytes: number[], type = "image/jpeg") {
  return new NodeFile([new Uint8Array(bytes)], "avatar", {
    type,
  }) as unknown as File;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("rejects SVG, disguised SVG and oversized input before creating a decoder URL", async () => {
  const create = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create });
  await expect(
    prepareAccountAvatar(file([60, 115, 118, 103], "image/svg+xml")),
  ).rejects.toThrow("PNG, JPEG or WebP");
  await expect(
    prepareAccountAvatar(file([60, 115, 118, 103], "image/jpeg")),
  ).rejects.toThrow("valid");
  await expect(
    prepareAccountAvatar(
      new NodeFile([new Uint8Array(5 * 1024 * 1024 + 1)], "large.jpg", {
        type: "image/jpeg",
      }) as unknown as File,
    ),
  ).rejects.toThrow("5 MB");
  expect(create).not.toHaveBeenCalled();
});
test("raster input is center-cropped and reencoded at 256px, with its temporary URL released", async () => {
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:avatar",
    revokeObjectURL: revoke,
  });
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1200;
      naturalHeight = 800;
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(),
    drawImage: draw,
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockImplementation(function (this: HTMLCanvasElement, mime, quality) {
      expect(this.width).toBe(256);
      expect(this.height).toBe(256);
      expect(mime).toBe("image/jpeg");
      expect(quality).toBe(0.85);
      return "data:image/jpeg;base64,/9j/AA==";
    });
  expect(await prepareAccountAvatar(file(jpeg))).toBe(
    "data:image/jpeg;base64,/9j/AA==",
  );
  expect(draw).toHaveBeenCalledWith(
    expect.anything(),
    200,
    0,
    800,
    800,
    0,
    0,
    256,
    256,
  );
  expect(encode).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith("blob:avatar");
});
