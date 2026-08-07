import { describe, expect, it } from "vitest";

import {
  createFileMessage,
  createUploadingFileMessage,
} from "../../src/features/messages/create-file-message";

describe("createFileMessage", () => {
  it("creates validated attachment metadata with device ownership", () => {
    const message = createFileMessage(
      {
        driveItemId: "drive-item",
        name: "photo.png",
        size: 5,
        mimeType: "image/png",
        imageWidth: 640,
        imageHeight: 480,
        thumbHash: "AQIDBA==",
      },
      "01989f5e-7700-7000-8000-000000000099",
      new Date("2026-08-03T00:00:00.000Z"),
      "01989f5e-7700-7000-8000-000000000001",
    );

    expect(message.type).toBe("file");
    expect(message.attachment.name).toBe("photo.png");
    expect(message.attachment).toMatchObject({
      imageWidth: 640,
      imageHeight: 480,
      thumbHash: "AQIDBA==",
    });
    expect(message.senderDeviceId).toBe("01989f5e-7700-7000-8000-000000000099");
  });

  it("creates a remote uploading placeholder before the attachment exists", () => {
    const message = createUploadingFileMessage(
      {
        name: "photo.png",
        size: 5,
        mimeType: "image/png",
        imageWidth: 640,
        imageHeight: 480,
      },
      "01989f5e-7700-7000-8000-000000000099",
      new Date("2026-08-03T00:00:00.000Z"),
      "01989f5e-7700-7000-8000-000000000001",
    );

    expect(message.type).toBe("file-uploading");
    expect(message.pendingAttachment.name).toBe("photo.png");
  });
});
