import { describe, expect, it } from "vitest";

import { enqueueDeletedDataMaintenance } from "@onedrop/onedrive/infrastructure/onedrive/deleted-data-coordinator";

describe("deleted-data maintenance coordinator", () => {
  it("serializes restore and cleanup work", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = enqueueDeletedDataMaintenance(async () => {
      order.push("cleanup-start");
      await firstGate;
      order.push("cleanup-end");
    });
    const second = enqueueDeletedDataMaintenance(async () => {
      order.push("restore");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["cleanup-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["cleanup-start", "cleanup-end", "restore"]);
  });
});
