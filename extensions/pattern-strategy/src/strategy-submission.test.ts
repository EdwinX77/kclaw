import { describe, expect, it } from "vitest";
import {
  findActiveStrategyWatch,
  isStrategyTerminalStatus,
  validateStrategyTaskRunSubmission,
} from "./strategy-submission.js";

describe("Pattern Strategy submission policy", () => {
  it("validates cron and recovery idempotency keys", () => {
    expect(
      validateStrategyTaskRunSubmission({
        task_key: "strategy.mid_term_accel.daily_scan",
        idempotency_key: "cron-mid-term-accel-2026-05-29",
        source: "openclaw_cron",
        requested_by: "openclaw_gateway",
        trace_id: "trace-1",
        trigger_type: "cron",
      }),
    ).toMatchObject({
      taskKey: "strategy.mid_term_accel.daily_scan",
      idempotencyKey: "cron-mid-term-accel-2026-05-29",
      marketDate: "2026-05-29",
    });

    expect(() =>
      validateStrategyTaskRunSubmission({
        task_key: "strategy.mid_term_accel.daily_scan",
        idempotency_key: "random-key",
        source: "openclaw_cron",
        requested_by: "openclaw_gateway",
        trace_id: "trace-1",
        trigger_type: "cron",
      }),
    ).toThrow("cron submissions require idempotency_key");

    expect(
      validateStrategyTaskRunSubmission({
        task_key: "strategy.mid_term_accel.daily_scan",
        idempotency_key: "recovery-mid-term-accel-2026-05-29-1",
        source: "openclaw_cron",
        requested_by: "openclaw_gateway",
        trace_id: "trace-2",
        trigger_type: "gateway_recovery",
      }),
    ).toMatchObject({
      triggerType: "gateway_recovery",
      marketDate: "2026-05-29",
    });
  });

  it("treats timeout as terminal and cancelling as active", () => {
    expect(isStrategyTerminalStatus("timeout")).toBe(true);
    expect(isStrategyTerminalStatus("failed")).toBe(true);
    expect(isStrategyTerminalStatus("cancelling")).toBe(false);
    expect(isStrategyTerminalStatus("running")).toBe(false);
  });

  it("finds active same-day watches and ignores completed runs", () => {
    const submission = validateStrategyTaskRunSubmission({
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-1",
      trigger_type: "cron",
    });

    expect(
      findActiveStrategyWatch({
        submission,
        watches: [
          {
            kind: "pattern_strategy_run",
            jobId: "old-failed",
            taskKey: "strategy.mid_term_accel.daily_scan",
            idempotencyKey: "cron-mid-term-accel-2026-05-29",
            sessionKey: "agent:pattern-strategy:cron:test",
            agentId: "pattern-strategy",
            wakeMode: "now",
            followupMode: "direct-agent-delivery",
            enrichSignals: true,
            maxSignals: 20,
            lastRemoteStatus: "timeout",
            registeredAt: 1,
            updatedAt: 1,
          },
          {
            kind: "pattern_strategy_run",
            jobId: "active",
            taskKey: "strategy.mid_term_accel.daily_scan",
            idempotencyKey: "cron-mid-term-accel-2026-05-29",
            marketDate: "2026-05-29",
            sessionKey: "agent:pattern-strategy:cron:test",
            agentId: "pattern-strategy",
            wakeMode: "now",
            followupMode: "direct-agent-delivery",
            enrichSignals: true,
            maxSignals: 20,
            lastRemoteStatus: "queued",
            registeredAt: 2,
            updatedAt: 2,
          },
        ],
      })?.jobId,
    ).toBe("active");
  });
});
