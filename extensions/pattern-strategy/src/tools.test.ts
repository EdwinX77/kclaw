import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { listAsyncWatches, upsertAsyncWatch } from "./async-watch-store.js";
import { createPatternStrategyTools } from "./tools.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-strategy-tools-"));
  tempDirs.push(dir);
  return dir;
}

function createApi(
  params: { stateDir?: string; info?: (message: string) => void } = {},
): OpenClawPluginApi {
  return {
    pluginConfig: {
      baseUrl: "http://pattern-strategy.local",
      chartBaseUrl: "http://charts.pattern-strategy.local",
    },
    runtime: {
      state: {
        resolveStateDir: () => params.stateDir ?? "",
      },
    },
    logger: {
      info: params.info ?? (() => {}),
      warn: () => {},
      error: () => {},
    },
  } as unknown as OpenClawPluginApi;
}

function latestTradeDateResponse(tradeDate = "2026-05-29", dataReady = true) {
  return new Response(
    JSON.stringify({
      ok: true,
      tool_name: "market.latest_available_trade_date",
      data: {
        trade_date: tradeDate,
        is_trading_day: true,
        data_ready: dataReady,
        previous_trade_date: "2026-05-28",
        source: "market_calendar",
      },
    }),
  );
}

function expectLatestTradeDateCall(fetchMock: ReturnType<typeof vi.spyOn>, callIndex = 0) {
  expect(fetchMock.mock.calls[callIndex]?.[0]).toBe(
    "http://pattern-strategy.local/tools/market.latest_available_trade_date/invoke",
  );
  const body = JSON.parse(
    String((fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.body ?? "{}"),
  );
  expect(body.arguments).toMatchObject({
    market: "CN_A",
    purpose: "daily_scan",
  });
  expect(body.arguments.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
}

describe("Pattern Strategy remote tools", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    return Promise.all(
      tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("submits strategy tasks with PI queue metadata and structured MCP logs", async () => {
    const info = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_run",
            data: {
              job_id: "run-1",
              status: "accepted",
              request_key: "strategy.mid_term_accel.daily_scan:cron-mid-term-accel-2026-05-29",
              resolved_window: { start_date: "2026-03-01", end_date: "2026-05-29" },
            },
          }),
        ),
      );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir(), info }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    await tool.execute("call-strategy", {
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-cron-1",
      trigger_type: "cron",
      overrides: { selection: { limit: 7000 } },
    });

    expectLatestTradeDateCall(fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://pattern-strategy.local/tools/strategy.task_run/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            task_key: "strategy.mid_term_accel.daily_scan",
            idempotency_key: "cron-mid-term-accel-2026-05-29",
            source: "openclaw_cron",
            requested_by: "openclaw_gateway",
            trace_id: "cron:job-1:2026-05-29",
            trigger_type: "cron",
            overrides: { selection: { limit: 7000 } },
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    const log = info.mock.calls
      .map((call) => JSON.parse(call[0] ?? "{}"))
      .find((entry) => entry.tool_name === "strategy.task_run");
    expect(log).toMatchObject({
      event: "pattern_strategy_mcp_call",
      tool_name: "strategy.task_run",
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "cron:job-1:2026-05-29",
      trigger_type: "cron",
      returned_job_id: "run-1",
      returned_status: "accepted",
    });
  });

  it("submits cron strategy tasks when market data_ready is false", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse("2026-08-07", false))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_run",
            data: {
              job_id: "run-data-not-ready",
              status: "accepted",
              request_key: "strategy.mid_term_accel.daily_scan:cron-mid-term-accel-2026-08-07",
              resolved_window: { start_date: "2026-05-01", end_date: "2026-08-07" },
            },
          }),
        ),
      );
    const ctx = {
      agentId: "tas-dispatch",
      sessionKey: "agent:tas-dispatch:cron:mid-term-accel:run:run-1",
    };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir() }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-data-not-ready", {
      task_key: "strategy.mid_term_accel.daily_scan",
      overrides: { selection: { limit: 7000 } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLatestTradeDateCall(fetchMock);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://pattern-strategy.local/tools/strategy.task_run/invoke",
    );
    const submissionBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body ?? "{}"),
    );
    expect(submissionBody.arguments).toMatchObject({
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-08-07",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "cron:mid-term-accel:2026-08-07",
      trigger_type: "cron",
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toMatchObject({
      job_id: "run-data-not-ready",
      idempotency_key: "cron-mid-term-accel-2026-08-07",
      market_date: "2026-08-07",
    });
  });

  it("generates cron submission metadata before validating model-supplied fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T21:10:00.000Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse("2026-06-12"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_run",
            data: {
              job_id: "run-generated-metadata",
              status: "accepted",
              request_key: "strategy.mid_term_accel.daily_scan:cron-mid-term-accel-2026-06-11",
              resolved_window: { start_date: "2026-03-14", end_date: "2026-06-11" },
            },
          }),
        ),
      );
    const ctx = {
      agentId: "tas-dispatch",
      sessionKey: "agent:tas-dispatch:cron:cron-job-generated:run:run-1",
    };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir() }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-generated-metadata", {
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "stale-model-key",
      source: "model_override",
      overrides: { selection: { limit: 7000 } },
    });

    const calendarBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? "{}"),
    );
    expect(calendarBody.arguments.as_of).toBe("2026-06-15T05:10:00+08:00");
    const submissionBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body ?? "{}"),
    );
    expect(submissionBody.arguments).toMatchObject({
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-06-12",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "cron:cron-job-generated:2026-06-12",
      trigger_type: "cron",
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toMatchObject({
      request_key: "strategy.mid_term_accel.daily_scan:cron-mid-term-accel-2026-06-11",
      idempotency_key: "cron-mid-term-accel-2026-06-11",
      resolved_window: { start_date: "2026-03-14", end_date: "2026-06-11" },
      market_date: "2026-06-11",
    });
  });

  it("allows the Feishu group front-door to enter the shared strategy queue", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          tool_name: "strategy.task_run",
          data: {
            job_id: "manual-group-run-1",
            status: "queued",
            request_key: "strategy.mid_term_accel.daily_scan:manual-mid-term-accel-2026-06-23-om_1",
            resolved_window: { start_date: "2026-04-01", end_date: "2026-06-23" },
          },
        }),
      ),
    );
    const ctx = {
      agentId: "tas-dispatch",
      sessionKey: "agent:tas-dispatch:feishu:group:oc_group:sender:ou_user",
    };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir() }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-feishu-group-manual", {
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "manual-mid-term-accel-2026-06-23-om_1",
      source: "feishu_group",
      requested_by: "openclaw_gateway",
      trace_id: "feishu:om_1",
      trigger_type: "manual",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://pattern-strategy.local/tools/strategy.task_run/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            task_key: "strategy.mid_term_accel.daily_scan",
            idempotency_key: "manual-mid-term-accel-2026-06-23-om_1",
            source: "feishu_group",
            requested_by: "openclaw_gateway",
            trace_id: "feishu:om_1",
            trigger_type: "manual",
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toMatchObject({
      job_id: "manual-group-run-1",
      status: "queued",
    });
  });

  it("blocks signal fetch until the live run status is succeeded", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          tool_name: "strategy.get_run",
          data: {
            job_id: "active-run-1",
            status: "running",
            progress: 1,
          },
        }),
      ),
    );
    const ctx = { agentId: "tas-dispatch", sessionKey: "agent:tas-dispatch:feishu:group:oc_test" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir() }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_get_signals");
    if (!tool) {
      throw new Error("missing strategy_get_signals");
    }

    await expect(
      tool.execute("call-signals", {
        job_id: "active-run-1",
        limit: 20,
        order: "desc",
      }),
    ).rejects.toThrow(
      "strategy_get_signals requires status=succeeded; job_id active-run-1 is running",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://pattern-strategy.local/tools/strategy.get_run/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            job_id: "active-run-1",
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
  });

  it("fetches signals after confirming the live run status is succeeded", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_run",
            data: {
              job_id: "finished-run-1",
              status: "succeeded",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_signals",
            data: [{ symbol: "688563", name: "航材股份", signal_date: "2026-06-23" }],
          }),
        ),
      );
    const ctx = { agentId: "tas-dispatch", sessionKey: "agent:tas-dispatch:feishu:group:oc_test" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir() }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_get_signals");
    if (!tool) {
      throw new Error("missing strategy_get_signals");
    }

    const result = await tool.execute("call-signals", {
      job_id: "finished-run-1",
      limit: 20,
      order: "desc",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://pattern-strategy.local/tools/strategy.get_run/invoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://pattern-strategy.local/tools/strategy.get_signals/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            job_id: "finished-run-1",
            limit: 20,
            order: "desc",
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toEqual([
      { symbol: "688563", name: "航材股份", signal_date: "2026-06-23" },
    ]);
  });

  it("normalizes stale cron strategy keys through the latest trade date service", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse("2026-06-15"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_run",
            data: {
              job_id: "run-strong-pivot",
              status: "accepted",
              request_key:
                "strategy.strong_pivot_breakout.daily_scan:cron-strong-pivot-breakout-2026-06-15",
              resolved_window: { start_date: "2026-04-01", end_date: "2026-06-15" },
            },
          }),
        ),
      );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir: await makeTempStateDir() }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-strong-pivot", {
      task_key: "strategy.strong_pivot_breakout.daily_scan",
      idempotency_key: "cron-strong-pivot-breakout-2026-06-12",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "cron:job-1:2026-06-12",
      trigger_type: "cron",
    });

    expectLatestTradeDateCall(fetchMock);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://pattern-strategy.local/tools/strategy.task_run/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            task_key: "strategy.strong_pivot_breakout.daily_scan",
            idempotency_key: "cron-strong-pivot-breakout-2026-06-15",
            source: "openclaw_cron",
            requested_by: "openclaw_gateway",
            trace_id: "cron:job-1:2026-06-15",
            trigger_type: "cron",
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toMatchObject({
      job_id: "run-strong-pivot",
      idempotency_key: "cron-strong-pivot-breakout-2026-06-15",
      market_date: "2026-06-15",
      latest_trade_date_source: "market_calendar",
    });
  });

  it("continues tracking an active same-day strategy run instead of submitting a duplicate", async () => {
    const stateDir = await makeTempStateDir();
    await upsertAsyncWatch({
      stateDir,
      watch: {
        kind: "pattern_strategy_run",
        jobId: "active-run-1",
        taskKey: "strategy.mid_term_accel.daily_scan",
        idempotencyKey: "cron-mid-term-accel-2026-05-29",
        source: "openclaw_cron",
        requestedBy: "openclaw_gateway",
        traceId: "trace-existing",
        triggerType: "cron",
        marketDate: "2026-05-29",
        requestKey: "cron-mid-term-accel-2026-05-29",
        sessionKey: "agent:pattern-strategy:cron:job-1",
        agentId: "pattern-strategy",
        wakeMode: "now",
        followupMode: "direct-agent-delivery",
        enrichSignals: true,
        maxSignals: 20,
        lastRemoteStatus: "running",
        registeredAt: 1,
        updatedAt: 1,
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_run",
            data: {
              job_id: "active-run-1",
              status: "running",
            },
          }),
        ),
      );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-strategy", {
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-cron-duplicate",
      trigger_type: "cron",
    });

    expectLatestTradeDateCall(fetchMock);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://pattern-strategy.local/tools/strategy.get_run/invoke",
      expect.objectContaining({ method: "POST" }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.tool_name).toBe("strategy.task_run");
    expect(parsed.data).toMatchObject({
      job_id: "active-run-1",
      status: "running",
      gateway_deduped: true,
      gateway_deduped_by_job_id: "active-run-1",
    });
  });

  it("does not dedupe through a watch whose remote run is already terminal", async () => {
    const stateDir = await makeTempStateDir();
    await upsertAsyncWatch({
      stateDir,
      watch: {
        kind: "pattern_strategy_run",
        jobId: "stale-run-1",
        taskKey: "strategy.strong_pivot_breakout.daily_scan",
        idempotencyKey: "cron-strong-pivot-breakout-2026-05-29",
        source: "openclaw_cron",
        requestedBy: "openclaw_gateway",
        traceId: "trace-cron-stale",
        triggerType: "cron",
        marketDate: "2026-05-29",
        requestKey:
          "strategy.strong_pivot_breakout.daily_scan:cron-strong-pivot-breakout-2026-05-29",
        sessionKey: "agent:pattern-strategy:cron:job-1",
        agentId: "pattern-strategy",
        wakeMode: "now",
        followupMode: "direct-agent-delivery",
        enrichSignals: true,
        maxSignals: 20,
        lastRemoteStatus: "running",
        registeredAt: 1,
        updatedAt: 1,
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_run",
            data: {
              job_id: "stale-run-1",
              status: "cancelled",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_run",
            data: {
              job_id: "fresh-run-1",
              status: "accepted",
              request_key:
                "strategy.strong_pivot_breakout.daily_scan:cron-strong-pivot-breakout-2026-05-29",
              resolved_window: { start_date: "2026-03-01", end_date: "2026-05-29" },
            },
          }),
        ),
      );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-strategy", {
      task_key: "strategy.strong_pivot_breakout.daily_scan",
      idempotency_key: "cron-strong-pivot-breakout-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-cron",
      trigger_type: "cron",
    });

    expectLatestTradeDateCall(fetchMock);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://pattern-strategy.local/tools/strategy.get_run/invoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://pattern-strategy.local/tools/strategy.task_run/invoke",
      expect.objectContaining({ method: "POST" }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toMatchObject({
      job_id: "fresh-run-1",
      status: "accepted",
    });
    expect(parsed.data.gateway_deduped).toBeUndefined();
    const [updated] = await listAsyncWatches(stateDir);
    expect(updated).toMatchObject({
      jobId: "stale-run-1",
      lastRemoteStatus: "cancelled",
      completedAt: expect.any(Number),
    });
  });

  it("submits a new strategy task when same-day active watches use a different idempotency key", async () => {
    const stateDir = await makeTempStateDir();
    await upsertAsyncWatch({
      stateDir,
      watch: {
        kind: "pattern_strategy_run",
        jobId: "manual-run-1",
        taskKey: "strategy.mid_term_accel.daily_scan",
        idempotencyKey: "manual-mid-term-accel-2026-05-29",
        source: "feishu_manual",
        requestedBy: "Edwin",
        traceId: "trace-manual",
        triggerType: "manual",
        marketDate: "2026-05-29",
        requestKey: "strategy.mid_term_accel.daily_scan:manual-mid-term-accel-2026-05-29",
        sessionKey: "agent:pattern-strategy:manual:test",
        agentId: "pattern-strategy",
        wakeMode: "now",
        followupMode: "direct-agent-delivery",
        enrichSignals: true,
        maxSignals: 20,
        lastRemoteStatus: "running",
        registeredAt: 1,
        updatedAt: 1,
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(latestTradeDateResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_run",
            data: {
              job_id: "cron-run-1",
              status: "accepted",
              request_key: "strategy.mid_term_accel.daily_scan:cron-mid-term-accel-2026-05-29",
              resolved_window: { start_date: "2026-03-01", end_date: "2026-05-29" },
            },
          }),
        ),
      );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(
      createApi({ stateDir }),
      ctx as OpenClawPluginToolContext,
    ).find((candidate) => candidate.name === "strategy_task_run");
    if (!tool) {
      throw new Error("missing strategy_task_run");
    }

    const result = await tool.execute("call-strategy", {
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-cron",
      trigger_type: "cron",
    });

    expectLatestTradeDateCall(fetchMock);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://pattern-strategy.local/tools/strategy.task_run/invoke",
      expect.objectContaining({ method: "POST" }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data).toMatchObject({
      job_id: "cron-run-1",
      status: "accepted",
    });
    expect(parsed.data.gateway_deduped).toBeUndefined();
  });

  it("rejects non-manual strategy cancellation attempts", async () => {
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(createApi(), ctx as OpenClawPluginToolContext).find(
      (candidate) => candidate.name === "strategy_cancel_run",
    );
    if (!tool) {
      throw new Error("missing strategy_cancel_run");
    }

    await expect(
      tool.execute("call-cancel", {
        job_id: "active-run-1",
        trigger_type: "cron",
        manual_confirmed: false,
      }),
    ).rejects.toThrow("only allowed for explicit manual cancellation");
  });

  it("bridges Chan chart generation to chan.generate_chart", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "chan.generate_chart",
            data: {
              chart_url: "/api/strategies/chart?path=charts/688563.png",
              chart_path: "charts/688563.png",
              signals_detected: 2,
              fractal_strength_summary: "strong top fractal volume",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("png"), {
          headers: {
            "content-type": "image/png",
          },
        }),
      );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:test" };
    const tool = createPatternStrategyTools(createApi(), ctx as OpenClawPluginToolContext).find(
      (candidate) => candidate.name === "chan_generate_chart",
    );
    if (!tool) {
      throw new Error("missing chan_generate_chart");
    }

    const result = await tool.execute("call-1", {
      symbol: "688563",
      start_date: "2025-12-01",
      end_date: "2026-05-15",
      use_price_cache: true,
      merge_threshold: 0.01,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://pattern-strategy.local/tools/chan.generate_chart/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            symbol: "688563",
            start_date: "2025-12-01",
            end_date: "2026-05-15",
            use_price_cache: true,
            merge_threshold: 0.01,
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://charts.pattern-strategy.local/api/strategies/chart?path=charts/688563.png",
      expect.any(Object),
    );
    expect(result.details?.remoteToolName).toBe("chan.generate_chart");
    expect(result.details?.data).toMatchObject({
      chart_url: "http://charts.pattern-strategy.local/api/strategies/chart?path=charts/688563.png",
      chart_media_path: expect.stringContaining("688563.png"),
      signals_detected: 2,
    });
    expect(result.details?.media).toMatchObject({
      mediaUrl: expect.stringContaining("688563.png"),
      mediaUrls: [expect.stringContaining("688563.png")],
      trustedLocalMedia: true,
    });
    expect(result.content[0]?.text).toContain("delivery_instruction");
    expect(result.content[0]?.text).toContain("concise Chan-theory reading");
    expect(result.content[0]?.text).not.toContain("do not describe or analyze");
    expect(result.content[0]?.text).not.toContain("MEDIA:/tmp/openclaw");
    expect(result.content[0]?.text).not.toContain("media_directive");
    expect(result.content[0]?.text).not.toContain("chart_url");
    expect(result.content[0]?.text).not.toContain("chart_path");
    expect(result.content[0]?.text).not.toContain("chart_media_path");
    expect(result.content[0]?.text).not.toContain("fractal_strength_summary");
    expect(result.content[0]?.text).not.toContain("strong top fractal volume");
  });

  it("bridges board index refresh to indice.refresh_run", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          tool_name: "indice.refresh_run",
          data: {
            job_id: "indice-job-1",
            status: "running",
            stage: "turnover",
            start_date: "2026-05-01",
            end_date: "2026-08-06",
            idempotency_key: "indice-daily-20260806",
            source: "openclaw_cron",
          },
        }),
      ),
    );
    const ctx = { agentId: "pattern-strategy", sessionKey: "agent:pattern-strategy:cron:job-1" };
    const tool = createPatternStrategyTools(createApi(), ctx as OpenClawPluginToolContext).find(
      (candidate) => candidate.name === "indice_refresh_run",
    );
    if (!tool) {
      throw new Error("missing indice_refresh_run");
    }

    const result = await tool.execute("call-indice", {
      start_date: "2026-02-25",
      end_date: "2026-05-25",
      dimensions: ["industry", "size", "style", "concept"],
      refresh_turnover: true,
      force_universe: false,
      source: "openclaw_cron",
      idempotency_key: "indice-daily-20260525",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://pattern-strategy.local/tools/indice.refresh_run/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            dimensions: ["industry", "size", "style", "concept"],
            refresh_turnover: true,
            force_universe: false,
            source: "openclaw_cron",
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    expect(result.details?.remoteToolName).toBe("indice.refresh_run");
    expect(result.details?.data).toMatchObject({
      job_id: "indice-job-1",
      status: "running",
      stage: "turnover",
      start_date: "2026-05-01",
      end_date: "2026-08-06",
      idempotency_key: "indice-daily-20260806",
      source: "openclaw_cron",
    });
  });
});
