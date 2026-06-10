import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildAsyncCompletionEvent,
  buildTerminalNotification,
} from "./async-watch-service.js";
import type { PatternStrategyAsyncWatch } from "./async-watch-store.js";

function createWatch(taskKey: string): PatternStrategyAsyncWatch {
  return {
    kind: "pattern_strategy_run",
    jobId: "claw_test",
    taskKey,
    sessionKey: "agent:tas-dispatch:cron:test",
    agentId: "tas-dispatch",
    wakeMode: "now",
    followupMode: "direct-agent-delivery",
    enrichSignals: true,
    maxSignals: 10,
    registeredAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pattern Strategy async watch notifications", () => {
  it("reads async formatted run status for watcher polling", async () => {
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        expect(String(url)).toBe("http://127.0.0.1:18080/tools/strategy.get_run/invoke");
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_run",
            data: {
              job_id: "claw_test",
              status: "succeeded",
              progress: 1,
            },
            error: null,
            meta: {},
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const runData = await __testing.fetchRunStatus({ jobId: "claw_test" });

    expect(runData?.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("formats mid-term accel fallback signals as Chinese historical signals", () => {
    const text = buildTerminalNotification({
      watch: createWatch("strategy.mid_term_accel.daily_scan"),
      runData: null,
      status: "succeeded",
      classification: {
        kind: "fallback_only",
        reason: "signals are outside recent_days=5 and match fallback_count=3",
      },
      signals: [
        {
          symbol: "301285.SZ",
          confidence: 0.8333562668302914,
          end_date: "2026-05-07",
        },
      ],
    });

    expect(text).toContain("策略：中期加速策略");
    expect(text).toContain("历史信号");
    expect(text).toContain("不代表今日新增信号");
    expect(text).toContain("信号日 2026-05-07");
    expect(text).toContain("本次返回的是历史信号");
    expect(text).not.toContain("置信度");
    expect(text).not.toContain("recent_days");
    expect(text).not.toContain("fallback_count");
    expect(text).not.toContain("fallback signals:");
    expect(text).not.toContain("end_date");
  });

  it("trusts server delivery metadata for recent non-fallback signals", () => {
    const classification = __testing.classifySignals({
      rows: [{ symbol: "002815.SZ", end_date: "2026-05-20" }],
      signalData: {
        items: [{ symbol: "002815.SZ", end_date: "2026-05-20" }],
        delivery: {
          mode: "recent_window_with_fallback",
          used_fallback: false,
          window_start: "2026-05-20",
          window_end: "2026-05-25",
        },
      },
      signalMeta: null,
      runData: { resolved_window: { end_date: "2026-05-27" } },
      watch: createWatch("strategy.strong_pivot_breakout.daily_scan"),
      policy: { recentDays: 1, fallbackMode: "latest_one", fallbackCount: 1 },
    });

    expect(classification.kind).toBe("actionable");
    expect(classification.reason).toContain("server delivery recent window");
  });

  it("trusts server delivery metadata for fallback signals", () => {
    const classification = __testing.classifySignals({
      rows: [{ symbol: "002815.SZ", end_date: "2026-05-20" }],
      signalData: {
        items: [{ symbol: "002815.SZ", end_date: "2026-05-20" }],
        delivery: {
          mode: "recent_window_with_fallback",
          used_fallback: true,
          window_start: "2026-05-20",
          window_end: "2026-05-25",
        },
      },
      signalMeta: null,
      runData: { resolved_window: { end_date: "2026-05-27" } },
      watch: createWatch("strategy.strong_pivot_breakout.daily_scan"),
      policy: { recentDays: 5, fallbackMode: "latest_one", fallbackCount: 1 },
    });

    expect(classification.kind).toBe("fallback_only");
    expect(classification.reason).toBe("server delivery used fallback");
  });

  it("formats mid-term reversal opt with its Chinese strategy name", () => {
    const text = buildTerminalNotification({
      watch: createWatch("strategy.mid_term_reversal_opt.daily_scan"),
      runData: { resolved_window: { end_date: "2026-05-13" } },
      status: "succeeded",
      classification: {
        kind: "fallback_only",
        reason: "latest_only returned only fallback-sized results without fresh-source metadata",
      },
      signals: [
        {
          symbol: "688345.SH",
          score: 91.246,
          signal_date: "2026-05-06",
        },
      ],
    });

    expect(text).toContain("策略：中期触底反转策略");
    expect(text).toContain("信号日：2026-05-13");
    expect(text).toContain("1. 688345.SH｜信号日 2026-05-06");
    expect(text).toContain("历史信号");
    expect(text).toContain("说明：本次未调用 DS 做资讯检索和因子包装。");
    expect(text).not.toContain("评分");
    expect(text).not.toContain("latest_only");
  });

  it("omits server parameter details from terminal error notifications", () => {
    const text = buildTerminalNotification({
      watch: createWatch("strategy.mid_term_accel.daily_scan"),
      runData: { message: "invalid override selection.limit with recent_days=5" },
      status: "failed",
      classification: {
        kind: "none",
        reason: "terminal status failed",
      },
      signals: [],
    });

    expect(text).toContain("服务端消息：已省略内部细节。");
    expect(text).not.toContain("selection.limit");
    expect(text).not.toContain("recent_days");
  });

  it("formats terminal-success signal fetch failures as retrying status", () => {
    const text = __testing.buildSignalFetchFailureNotification({
      watch: createWatch("strategy.strong_pivot_breakout.daily_scan"),
      runData: { status: "succeeded", completed_at: "2026-06-01T23:48:00Z" },
      error: new Error("Pattern Strategy service timed out after 30000ms"),
    });

    expect(text).toContain("策略任务已完成，但信号结果暂时拉取失败");
    expect(text).toContain("策略：强势枢轴突破策略");
    expect(text).toContain("任务状态：成功");
    expect(text).toContain("strategy.get_signals 超时");
    expect(text).toContain("watcher 会继续在后台重试");
    expect(text).toContain("后端恢复后会自动拉取正式信号并触发 CANSLIM enrichment 推送");
    expect(text).toContain("尚未调用 DS");
  });

  it("injects the CANSLIM boundary contract into actionable async callbacks", () => {
    const event = buildAsyncCompletionEvent({
      watch: createWatch("strategy.mid_term_accel.daily_scan"),
      runData: { status: "succeeded", resolved_window: { end_date: "2026-05-15" } },
      signals: [{ symbol: "603928.SH", end_date: "2026-05-15", confidence: 0.89 }],
      tradingPrinciples: ["股价低于20的不要参与不要参与。"],
    });

    expect(event).toContain("Required skill: canslim-enrichment");
    expect(event).toContain("Do not call messaging delivery tools from this callback");
    expect(event).toContain("Return exactly one final Chinese summary for Feishu");
    expect(event).toContain("Do not narrate your process");
    expect(event).toContain("Market timezone: Asia/Shanghai");
    expect(event).toContain("Do not submit a new strategy task from this callback.");
    expect(event).toContain("Final Feishu reply must use these sections exactly");
    expect(event).toContain("Strategy construction confidentiality");
    expect(event).toContain("这类问题不予回复。");
    expect(event).toContain("交易原则检查");
    expect(event).toContain("trading_principles_json");
    expect(event).not.toContain("resolved_window:");
    expect(event).not.toContain('"confidence"');
  });

  it("builds Feishu signal table cards for actionable callback delivery", () => {
    const payload = __testing.buildFeishuSignalTablePayload({
      watch: createWatch("strategy.strong_pivot_breakout.daily_scan"),
      runData: { resolved_window: { end_date: "2026-05-27" } },
      signals: [
        {
          symbol: "002669.SZ",
          name: "康达新材",
          industry: "化学制品",
          end_date: "2026-05-27",
          comment: "强枢轴突破，量价结构转强。",
        },
      ],
    });

    expect(payload?.text).toContain("002669.SZ 康达新材");
    expect(payload?.channelData?.feishu).toBeTruthy();
    const card = (payload?.channelData?.feishu as { card?: Record<string, unknown> }).card;
    expect(card?.schema).toBe("2.0");
    expect(card?.header).toMatchObject({
      title: { content: "强势枢轴突破策略｜最新信号" },
    });
    const elements = (card?.body as { elements?: Array<Record<string, unknown>> }).elements ?? [];
    const table = elements.find((element) => element.tag === "table");
    expect(table).toMatchObject({
      tag: "table",
      rows: [
        {
          symbol: "002669.SZ",
          name: "康达新材",
          industry: "化学制品",
          signal_date: "2026-05-27",
          point: "强枢轴突破，量价结构转强。",
        },
      ],
    });
  });
});
