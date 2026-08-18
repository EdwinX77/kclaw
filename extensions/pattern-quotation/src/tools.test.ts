import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { createPatternQuotationTools } from "./tools.js";

function createApi(): OpenClawPluginApi {
  return {
    pluginConfig: { baseUrl: "http://pattern-quotation.local" },
  } as unknown as OpenClawPluginApi;
}

function response(data: Record<string, unknown>, toolName: string) {
  return new Response(
    JSON.stringify({
      ok: true,
      tool_name: toolName,
      data,
    }),
  );
}

describe("Pattern Quotation remote tools", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lets the backend own a cron chain's current-session date and idempotency", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          job_id: "quotation-20260807",
          status: "pending",
          message: "accepted",
          start_date: "2026-08-07",
          end_date: "2026-08-07",
          idempotency_key: "quotation:sentiment_intraday:20260807",
          chain_key: "sentiment_intraday",
          stages: ["sentiment"],
        },
        "quotation.refresh_run",
      ),
    );
    const ctx = {
      agentId: "pattern-quotation",
      sessionKey: "agent:pattern-quotation:cron:quotation-pre-market:run:test-run",
    } as OpenClawPluginToolContext;
    const tool = createPatternQuotationTools(createApi(), ctx).find(
      (candidate) => candidate.name === "quotation_refresh_chain",
    );
    if (!tool) {
      throw new Error("missing quotation_refresh_chain");
    }

    const result = await tool.execute("call-quotation", {
      chain_key: "sentiment_intraday",
      start_date: "2026-08-05",
      end_date: "2026-08-05",
      source: "model_override",
      idempotency_key: "quotation:pre_market:20260805",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const refreshRequestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof refreshRequestBody !== "string") {
      throw new Error("refresh request body was not JSON text");
    }
    const refreshBody = JSON.parse(refreshRequestBody);
    expect(refreshBody.arguments).toEqual({
      chain_key: "sentiment_intraday",
      include_symbols: "*",
      symbols: [],
      adjust: "qfq",
      max_workers: 4,
      source: "openclaw_cron",
    });
    const visible = JSON.parse(result.content[0].text);
    expect(visible.data).toMatchObject({
      requested_start_date: "2026-08-07",
      requested_end_date: "2026-08-07",
      request_key: "quotation:sentiment_intraday:20260807",
      market_timezone: "Asia/Shanghai",
    });
  });

  it("rejects a manual refresh response that differs from its explicit requested window", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          job_id: "stale-quotation-job",
          status: "completed",
          start_date: "2026-08-05",
          end_date: "2026-08-05",
          idempotency_key: "quotation:pre_market:20260805",
          chain_key: "pre_market",
          stages: ["events", "prices", "financials"],
        },
        "quotation.refresh_run",
      ),
    );
    const ctx = {
      agentId: "pattern-quotation",
      sessionKey: "agent:pattern-quotation:feishu:manual-request",
    } as OpenClawPluginToolContext;
    const tool = createPatternQuotationTools(createApi(), ctx).find(
      (candidate) => candidate.name === "quotation_refresh_chain",
    );
    if (!tool) {
      throw new Error("missing quotation_refresh_chain");
    }

    await expect(
      tool.execute("call-quotation", {
        chain_key: "pre_market",
        start_date: "2026-08-06",
        end_date: "2026-08-06",
        idempotency_key: "quotation:pre_market:20260806",
      }),
    ).rejects.toThrow(
      "canonical response mismatched submitted request: start_date, end_date, idempotency_key",
    );
  });

  it("leaves an omitted manual date window for the backend calendar to resolve", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          job_id: "manual-calendar-job",
          status: "pending",
          start_date: "2026-10-09",
          end_date: "2026-10-09",
          idempotency_key: null,
          chain_key: "pre_market",
          stages: ["events", "prices", "financials"],
        },
        "quotation.refresh_run",
      ),
    );
    const ctx = {
      agentId: "pattern-quotation",
      sessionKey: "agent:pattern-quotation:feishu:manual-request",
    } as OpenClawPluginToolContext;
    const tool = createPatternQuotationTools(createApi(), ctx).find(
      (candidate) => candidate.name === "quotation_refresh_chain",
    );
    if (!tool) {
      throw new Error("missing quotation_refresh_chain");
    }

    const result = await tool.execute("call-quotation", { chain_key: "pre_market" });

    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("refresh request body was not JSON text");
    }
    const submitted = JSON.parse(requestBody).arguments;
    expect(submitted).not.toHaveProperty("start_date");
    expect(submitted).not.toHaveProperty("end_date");
    expect(submitted).not.toHaveProperty("idempotency_key");
    const visible = JSON.parse(result.content[0].text);
    expect(visible.data).toMatchObject({
      requested_start_date: "2026-10-09",
      requested_end_date: "2026-10-09",
    });
    expect(visible.data).not.toHaveProperty("request_key");
  });
});
