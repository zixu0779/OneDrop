import { describe, expect, it } from "vitest";

import { enqueueMonthWrite } from "../../src/infrastructure/onedrive/month-write-coordinator";

describe("month write coordinator", () => {
  it("runs month metadata writes in request order", async () => {
    const order: string[] = [];
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = enqueueMonthWrite(async () => {
      order.push("first-start");
      markFirstStarted();
      await firstGate;
      order.push("first-finish");
      return "first";
    });
    const second = enqueueMonthWrite(async () => {
      order.push("second");
      return "second";
    });

    await firstStarted;
    expect(order).toEqual(["first-start"]);
    finishFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-finish", "second"]);
  });

  it("continues after an earlier write fails", async () => {
    await expect(
      enqueueMonthWrite(async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    await expect(enqueueMonthWrite(async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});
