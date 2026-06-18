// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";
import {
  dispatchGatewayCronFinishedNotifications,
  dispatchGatewayCronStartedNotifications,
} from "./server-cron-notifications.js";

const { sendCronAnnouncePayloadStrictMock } = vi.hoisted(() => ({
  sendCronAnnouncePayloadStrictMock: vi.fn(async () => {}),
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
  };
});

beforeEach(() => {
  sendCronAnnouncePayloadStrictMock.mockClear();
});

describe("dispatchGatewayCronFinishedNotifications", () => {
  it("redacts invalid completion webhook targets in warnings", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-redact",
      name: "redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "ftp://user:secret@example.invalid/hook?token=secret",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: "cron-redact",
        deliveryTo: "ftp://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  });
});

describe("dispatchGatewayCronStartedNotifications", () => {
  it("announces started cron runs to the configured delivery target", async () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-start",
      name: "start notify",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "feishu",
        to: "chat-1",
        threadId: "thread-1",
        accountId: "bot-1",
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronStartedNotifications({
      evt: {
        jobId: job.id,
        action: "started",
        runAtMs: Date.parse("2026-06-17T20:10:00.000Z"),
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "agent-1", cfg: { marker: true } as never }),
    });

    await vi.waitFor(() => {
      expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledTimes(1);
    });
    expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        jobId: "cron-start",
        cfg: { marker: true },
        target: expect.objectContaining({
          channel: "feishu",
          to: "chat-1",
          threadId: "thread-1",
          accountId: "bot-1",
        }),
        message: expect.stringContaining('Cron job "start notify" started.'),
      }),
    );
  });
});
