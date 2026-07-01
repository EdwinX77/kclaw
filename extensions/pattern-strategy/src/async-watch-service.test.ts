import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import {
  __testing,
  buildAsyncCompletionEvent,
  buildTerminalNotification,
} from "./async-watch-service.js";
import {
  listAsyncWatches,
  upsertAsyncWatch,
  type PatternStrategyAsyncWatch,
} from "./async-watch-store.js";
import { listAutomationRuns, recordAutomationRun } from "./automation-run-store.js";

const tempDirs: string[] = [];
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pattern-strategy-watch-"));
  tempDirs.push(dir);
  return dir;
}

function createApi(stateDir: string): OpenClawPluginApi {
  return {
    config: {},
    pluginConfig: { baseUrl: "http://127.0.0.1:18080" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
    },
  } as unknown as OpenClawPluginApi;
}

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

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
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

  it("records scheduled terminal strategy watches even when signals are historical", async () => {
    const stateDir = await makeTempDir();
    const workspaceDir = await makeTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const toolName = String(url).split("/tools/")[1]?.split("/invoke")[0];
      if (toolName === "strategy.get_run") {
        return new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_run",
            data: {
              job_id: "claw_test",
              status: "succeeded",
              resolved_window: { end_date: "2026-06-15" },
            },
            meta: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (toolName === "strategy.get_signals") {
        return new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.get_signals",
            data: {
              raw_count: 10,
              items: [{ symbol: "300481.SZ", end_date: "2026-06-06" }],
              delivery: { used_fallback: true },
            },
            meta: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          tool_name: "strategy.task_describe",
          data: {
            signal_delivery: {
              recent_days: 5,
              fallback_mode: "latest_one",
              fallback_count: 1,
            },
          },
          meta: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await __testing.processPendingWatch({
      api: createApi(stateDir),
      stateDir,
      workspaceDir,
      watch: {
        ...createWatch("strategy.strong_pivot_breakout.daily_scan"),
        source: "openclaw_cron",
        traceId: "cron:daily-strong-pivot:2026-06-15",
        triggerType: "cron",
        resolvedWindow: { end_date: "2026-06-15" },
      },
    });

    const records = await listAutomationRuns({ stateDir });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "openclaw_cron",
      category: "strategy",
      taskFamily: "strong_pivot_breakout",
      taskKey: "strategy.strong_pivot_breakout.daily_scan",
      cronJobId: "daily-strong-pivot",
      businessJobId: "claw_test",
      status: "succeeded",
      rawCount: 10,
      returnedCount: 0,
      symbols: [],
    });
    expect(records[0]?.notes).toContain("历史信号");
  });

  it("defers volatile cancelled statuses for newly registered scheduled watches", async () => {
    const stateDir = await makeTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const now = Date.now();
    const watch = {
      ...createWatch("strategy.strong_pivot_breakout.daily_scan"),
      jobId: "claw_cancel_race",
      source: "openclaw_cron",
      triggerType: "cron",
      traceId: "cron:daily-strong-pivot:2026-06-17",
      requestKey: "strategy.strong_pivot_breakout.daily_scan:cron-strong-pivot-breakout-2026-06-17",
      registeredAt: now - 60_000,
      updatedAt: now - 60_000,
    };
    await upsertAsyncWatch({ stateDir, watch });
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          tool_name: "strategy.get_run",
          data: {
            job_id: "claw_cancel_race",
            status: "cancelled",
          },
          meta: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await __testing.processPendingWatch({
      api: createApi(stateDir),
      stateDir,
      watch,
    });

    const [updated] = await listAsyncWatches(stateDir);
    expect(updated).toMatchObject({
      jobId: "claw_cancel_race",
      lastRemoteStatus: "cancelled_pending_confirmation",
    });
    expect(updated?.completedAt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers recent-window reversal signals from a previous successful automation run", async () => {
    const stateDir = await makeTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await recordAutomationRun({
      stateDir,
      record: {
        source: "openclaw_cron",
        category: "strategy",
        taskFamily: "mid_term_reversal_opt",
        taskKey: "strategy.mid_term_reversal_opt.daily_scan",
        cronJobId: "daily-reversal",
        businessJobId: "claw_previous_reversal",
        status: "succeeded",
        rawCount: 2,
        returnedCount: 2,
        symbols: ["301288.SZ", "002345.SZ"],
      },
    });
    const watch = {
      ...createWatch("strategy.mid_term_reversal_opt.daily_scan"),
      jobId: "claw_current_reversal",
      source: "openclaw_cron",
      triggerType: "cron",
      traceId: "cron:daily-reversal:2026-06-18",
      requestKey: "strategy.mid_term_reversal_opt.daily_scan:cron-mid-term-reversal-opt-2026-06-18",
      idempotencyKey: "cron-mid-term-reversal-opt-2026-06-18",
      resolvedWindow: { end_date: "2026-06-18" },
      maxSignals: 5,
    };
    await upsertAsyncWatch({ stateDir, watch });
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const toolName = String(url).split("/tools/")[1]?.split("/invoke")[0];
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          arguments?: Record<string, unknown>;
        };
        if (toolName === "strategy.get_run") {
          return new Response(
            JSON.stringify({
              ok: true,
              tool_name: "strategy.get_run",
              data: {
                job_id: "claw_current_reversal",
                status: "succeeded",
                resolved_window: { end_date: "2026-06-18" },
              },
              meta: {},
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (toolName === "strategy.get_signals") {
          const jobId = body.arguments?.job_id;
          return new Response(
            JSON.stringify({
              ok: true,
              tool_name: "strategy.get_signals",
              data:
                jobId === "claw_previous_reversal"
                  ? {
                      items: [
                        { symbol: "301288.SZ", name: "东华测试", end_date: "2026-06-17" },
                        { symbol: "002345.SZ", name: "潮宏基", end_date: "2026-06-17" },
                      ],
                      delivery: {
                        mode: "recent_window_only",
                        used_fallback: false,
                        window_end: "2026-06-18",
                      },
                    }
                  : { items: [] },
              meta: {},
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            tool_name: "strategy.task_describe",
            data: {
              signal_delivery: {
                mode: "recent_window_only",
                date_field: "end_date",
                calendar_type: "trade_day",
                recent_days: 2,
                fallback_mode: "latest_one",
                fallback_count: 1,
                max_items: 5,
              },
            },
            meta: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await __testing.processPendingWatch({
      api: createApi(stateDir),
      stateDir,
      watch,
    });

    const records = await listAutomationRuns({ stateDir });
    const currentRecord = records.find(
      (record) => record.businessJobId === "claw_current_reversal",
    );
    expect(currentRecord).toMatchObject({
      returnedCount: 2,
      symbols: ["301288.SZ", "002345.SZ"],
    });
    const [updated] = await listAsyncWatches(stateDir);
    expect(updated).toMatchObject({
      jobId: "claw_current_reversal",
      signalDeliveryKind: "actionable",
      dsInvoked: true,
      callbackDeliveryStatus: "not-requested",
    });
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
    expect(event).toContain("Return only the requested compact summary object");
    expect(event).toContain("Do not narrate your process");
    expect(event).toContain("Market timezone: Asia/Shanghai");
    expect(event).toContain("Do not submit a new strategy task from this callback.");
    expect(event).toContain("Final reply contract: output exactly one compact JSON object");
    expect(event).toContain('"signal_enrichment"');
    expect(event).toContain("one independent analysis object per formal signal symbol");
    expect(event).toContain("overall_ranking must summarize the composite ranking");
    expect(event).toContain(
      "The async watcher owns the Feishu card, per-symbol CANSLIM section labels",
    );
    expect(event).toContain("Strategy construction confidentiality");
    expect(event).toContain("这类问题不予回复。");
    expect(event).toContain("trading_principles_json");
    expect(event).not.toContain("resolved_window:");
    expect(event).not.toContain('"confidence"');
  });

  it("extracts overall analysis while dropping generated template noise", () => {
    expect(
      __testing.extractOverallAnalysisText([
        {
          text: [
            "Enrichment 数据已拉取。现在汇总输出。",
            "",
            "| 代码 | 名称 |",
            "| ---- | ---- |",
            "| 002669.SZ | 康达新材 |",
            "",
            "总体分析：本批信号的量价结构较活跃，但基本面验证仍需跟进，仓位上应等待回踩确认。",
          ].join("\n"),
        },
      ]),
    ).toBe("本批信号的量价结构较活跃，但基本面验证仍需跟进，仓位上应等待回踩确认。");
  });

  it("extracts structured CANSLIM enrichment from model callback output", () => {
    const summary = __testing.extractModelSignalSummary([
      {
        text: JSON.stringify({
          overall_ranking:
            "综合排序：1）002669.SZ 数据支撑最完整；2）603928.SH 资金改善但财务确认不足。",
          signal_enrichment: [
            {
              symbol: "002669.SZ",
              rank: 1,
              ranking_reason: "量价突破与融资余额改善同时出现，排第一。",
              data_support: "财务成长取 2026Q1 收入同比 +18%，融资余额近5日 +6.2%。",
              financial_growth: "2026Q1 收入同比 +18%，扣非利润同比 +11%。",
              institution_holder_change: "最新前十大流通股东机构持股环比 +1.4pct。",
              margin_balance_change: "融资余额近5日 +6.2%，资金参与度改善。",
              sentiment_heat: "近3日公告与行业新闻热度中性偏强。",
              information_gaps: "缺少最新订单分产品拆分。",
              trading_principles: "等待回踩不破突破位后再评估。",
            },
            {
              symbol: "603928.SH",
              rank: 2,
              ranking_reason: "资金改善存在，但财务成长确认弱于第一名。",
              data_support: "融资余额近5日 +3.1%，机构持仓暂无连续增持数据。",
              financial_growth: "2026Q1 收入同比 +7%，利润增速低于收入。",
              institution_holder_change: "机构持仓暂无连续增持证据。",
              margin_balance_change: "融资余额近5日 +3.1%。",
              sentiment_heat: "舆情热度中性。",
              information_gaps: "缺少最新毛利率变化。",
              trading_principles: "只在放量延续后纳入观察。",
            },
          ],
        }),
      },
    ]);

    expect(summary.overallAnalysis).toContain("1）002669.SZ 数据支撑最完整");
    expect(summary.signalEnrichment).toHaveLength(2);
    expect(summary.signalEnrichment[0]).toMatchObject({
      symbol: "002669.SZ",
      rank: "第1位",
      rankingReason: "量价突破与融资余额改善同时出现，排第一。",
      dataSupport: "财务成长取 2026Q1 收入同比 +18%，融资余额近5日 +6.2%。",
      financialGrowth: "2026Q1 收入同比 +18%，扣非利润同比 +11%。",
    });
  });

  it("recovers structured CANSLIM enrichment embedded in an overall summary field", () => {
    const summary = __testing.extractModelSignalSummary([
      {
        text: JSON.stringify({
          overall_analysis: JSON.stringify({
            overall_ranking: "综合排序：万顺新材第一，浙江众成第二。",
            signal_enrichment: [
              {
                symbol: "300057.SZ",
                rank: 1,
                ranking_reason: "盈利加速叠加产业量产拐点，排序第一。",
                data_support: "2026Q1 净利润同比 +430%，融资余额近一月增长 25%。",
                financial_growth: "2026Q1 营收同比 +16%，净利润同比 +430%。",
                institution_holder_change: "机构持仓证据不足，列为缺口。",
                margin_balance_change: "融资余额近一月增长 25% 至 4.82 亿元。",
                sentiment_heat: "产业量产和客户验证带来热度。",
                information_gaps: "缺少最新机构连续增持证据。",
                trading_principles: "不追高，等待量价延续确认。",
              },
            ],
          }),
        }),
      },
    ]);

    expect(summary.overallAnalysis).toBe("万顺新材第一，浙江众成第二。");
    expect(summary.signalEnrichment).toHaveLength(1);
    expect(summary.signalEnrichment[0]).toMatchObject({
      symbol: "300057.SZ",
      rank: "第1位",
      rankingReason: "盈利加速叠加产业量产拐点，排序第一。",
      dataSupport: "2026Q1 净利润同比 +430%，融资余额近一月增长 25%。",
      marginBalanceChange: "融资余额近一月增长 25% 至 4.82 亿元。",
    });
  });

  it("builds standardized Feishu signal summary cards for actionable callback delivery", () => {
    const payload = __testing.buildStrategySignalSummaryPayload({
      watch: createWatch("strategy.strong_pivot_breakout.daily_scan"),
      runData: { status: "succeeded", resolved_window: { end_date: "2026-05-27" } },
      signals: [
        {
          symbol: "002669.SZ",
          name: "康达新材",
          industry: "化学制品",
          end_date: "20260527",
          comment: "强枢轴突破，量价结构转强。",
        },
      ],
      overallAnalysis: "综合排序：1）002669.SZ 数据支撑最完整，优先级最高。",
      signalEnrichment: [
        {
          symbol: "002669.SZ",
          rank: "第1位",
          rankingReason: "量价突破叠加融资余额改善，排序第一。",
          dataSupport: "2026Q1 收入同比 +18%，融资余额近5日 +6.2%。",
          financialGrowth: "2026Q1 收入同比 +18%，扣非利润同比 +11%。",
          institutionHolderChange: "最新机构持仓环比 +1.4pct。",
          marginBalanceChange: "融资余额近5日 +6.2%。",
          sentimentHeat: "近3日行业热度中性偏强。",
          informationGaps: "缺少最新订单拆分。",
          tradingPrinciples: "等待回踩确认，不追高。",
        },
      ],
      includeFeishuCard: true,
    });

    expect(payload?.text).toContain("策略：强势枢轴突破策略");
    expect(payload?.text).toContain("逐标的 CANSLIM 分析：");
    expect(payload?.text).toContain("第1位 002669.SZ：量价突破叠加融资余额改善，排序第一。");
    expect(payload?.text).toContain("数据支撑：2026Q1 收入同比 +18%，融资余额近5日 +6.2%。");
    expect(payload?.text).toContain("总体排序分析：综合排序：1）002669.SZ");
    expect(payload?.channelData?.feishu).toBeTruthy();
    const card = (payload?.channelData?.feishu as { card?: Record<string, unknown> }).card;
    expect(card?.schema).toBe("2.0");
    expect(card?.header).toMatchObject({
      title: { content: "强势枢轴突破策略｜策略信号" },
    });
    const elements = (card?.body as { elements?: Array<Record<string, unknown>> }).elements ?? [];
    expect(elements[0]).toMatchObject({
      tag: "markdown",
      content: expect.stringContaining("**状态**：成功"),
    });
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
    expect(elements.at(-3)).toMatchObject({
      tag: "markdown",
      content: expect.stringContaining("**逐标的 CANSLIM 分析**"),
    });
    expect(elements.at(-2)).toMatchObject({
      tag: "markdown",
      content: expect.stringContaining("**总体排序分析**"),
    });
  });
});
