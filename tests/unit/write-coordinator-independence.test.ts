import { describe, expect, it, vi } from "vitest";

describe("OneDrive write coordinators", () => {
  it("does not make a message write wait for an active tombstone write", async () => {
    vi.resetModules();
    const { enqueueMonthWrite } =
      await import("../../src/infrastructure/onedrive/month-write-coordinator");
    const { enqueueTombstoneWrite } =
      await import("../../src/infrastructure/onedrive/tombstone-write-coordinator");
    let finishDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    const events: string[] = [];

    const deletion = enqueueTombstoneWrite(async () => {
      events.push("delete-started");
      await deleteGate;
      events.push("delete-finished");
    });
    await Promise.resolve();

    await enqueueMonthWrite(async () => {
      events.push("send-finished");
    });

    expect(events).toEqual(["delete-started", "send-finished"]);
    finishDelete();
    await deletion;
  });

  it("still serializes two tombstone writes", async () => {
    vi.resetModules();
    const { enqueueTombstoneWrite } =
      await import("../../src/infrastructure/onedrive/tombstone-write-coordinator");
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const events: string[] = [];
    const first = enqueueTombstoneWrite(async () => {
      events.push("first-started");
      await firstGate;
      events.push("first-finished");
    });
    const second = enqueueTombstoneWrite(async () => {
      events.push("second-started");
    });

    await vi.waitFor(() => expect(events).toEqual(["first-started"]));
    expect(events).toEqual(["first-started"]);
    finishFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-started",
      "first-finished",
      "second-started",
    ]);
  });
});
