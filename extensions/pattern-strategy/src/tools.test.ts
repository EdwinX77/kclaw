import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { upsertAsyncWatch } from "./async-watch-store.js";
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

describe("Pattern Strategy remote tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    return Promise.all(
      tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("submits strategy tasks with PI queue metadata and structured MCP logs", async () => {
    const info = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          tool_name: "strategy.task_run",
          data: {
            job_id: "run-1",
            status: "accepted",
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
            trace_id: "trace-cron-1",
            trigger_type: "cron",
            overrides: { selection: { limit: 7000 } },
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    const log = JSON.parse(info.mock.calls[0]?.[0] ?? "{}");
    expect(log).toMatchObject({
      event: "pattern_strategy_mcp_call",
      tool_name: "strategy.task_run",
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-cron-1",
      trigger_type: "cron",
      returned_job_id: "run-1",
      returned_status: "accepted",
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
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

    expect(fetchMock).toHaveBeenCalledWith(
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
            start_date: "2026-02-25",
            end_date: "2026-05-25",
            dimensions: ["industry", "size", "style", "concept"],
            refresh_turnover: true,
            force_universe: false,
            source: "openclaw_cron",
            idempotency_key: "indice-daily-20260525",
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
    });
  });
});
