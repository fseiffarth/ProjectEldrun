/**
 * Desktop mutations queue per domain (`MobileBridgeHost.enqueueMutation`). On
 * one shared chain a slow mail reply ahead of a tab create made the phone read
 * "desktop unavailable" for the create — the sidecar's deadline started at
 * emit — and then watch the tab appear anyway.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { enqueueMutation } from "../../components/mobile/MobileBridgeHost";

const later = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe("bridge mutation queues", () => {
  it("does not make a tab create wait behind a slow mail reply", async () => {
    const order: string[] = [];
    let releaseMail = () => {};
    const mail = enqueueMutation("mail", () => new Promise<void>((resolve) => { releaseMail = () => { order.push("mail"); resolve(); }; }));
    const create = enqueueMutation("tabs", async () => { order.push("create"); });
    await create;
    expect(order).toEqual(["create"]);
    releaseMail();
    await mail;
    expect(order).toEqual(["create", "mail"]);
  });

  it("keeps one domain's mutations in order, a failure included", async () => {
    const order: string[] = [];
    const first = enqueueMutation("board", async () => { await later(10); order.push("first"); throw new Error("refused"); });
    const second = enqueueMutation("board", async () => { order.push("second"); });
    await expect(first).rejects.toThrow("refused");
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});
