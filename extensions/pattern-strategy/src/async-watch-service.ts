import { getReplyFromConfig } from "../../../src/auto-reply/reply.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { appendAgentInteractionAuditRecord } from "../../../src/infra/agent-interaction-audit.js";
import { ASYNC_COMPLETION_EVENT_PREFIX } from "../../../src/infra/heartbeat-events-filter.js";
import { deliverOutboundPayloads } from "../../../src/infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../../../src/infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../../../src/infra/outbound/session-context.js";
import type { OpenClawPluginApi, OpenClawPluginService } from "../../../src/plugins/types.js";
import {
  listAsyncWatches,
  type PatternStrategyAsyncWatch,
  updateAsyncWatch,
} from "./async-watch-store.js";
import { formatPatternStrategyResult, invokePatternStrategyTool } from "./client.js";
import {
  listIndiceAsyncWatches,
  type IndiceRefreshAsyncWatch,
  updateIndiceAsyncWatch,
} from "./indice-watch-store.js";
import {
  buildCanslimEnrichmentContract,
  buildStrategyConstructionConfidentialityRule,
  extractMarketDateText,
  isOutsideRecentMarketWindow,
  MARKET_TIMEZONE,
} from "./model-boundary-harness.js";
import { normalizeStrategyStatus, STRATEGY_TERMINAL_STATUSES } from "./strategy-submission.js";

type PatternStrategyPluginConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  asyncPollSeconds?: number;
  tradingPrinciples?: string[];
};

type SignalFetchResult = {
  rows: unknown[];
  data: unknown;
  meta: unknown;
};

type SignalDeliveryPolicy = {
  mode?: string;
  dateField?: string;
  recentDays?: number;
  fallbackMode?: string;
  fallbackCount?: number;
  maxItems?: number;
};

type SignalDeliveryClassification = {
  kind: "actionable" | "fallback_only" | "none";
  reason: string;
};

type SignalDeliveryMeta = {
  source?: string;
  mode?: string;
  windowStart?: string;
  windowEnd?: string;
  usedFallback?: boolean;
};

type WatchServiceState = {
  stopRequested: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
  stateDir?: string;
};

const INDICE_TERMINAL_STATUSES = new Set(["completed", "partial_failed", "failed"]);
const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 5_000;

function resolvePollMs(config?: PatternStrategyPluginConfig) {
  const seconds = config?.asyncPollSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.max(MIN_POLL_MS, Math.floor(seconds * 1000));
  }
  return DEFAULT_POLL_MS;
}

function normalizeStatus(value: unknown): string {
  return normalizeStrategyStatus(value);
}

function summarizeSignals(data: unknown, maxItems: number) {
  const rows = Array.isArray(data) ? data : [];
  return rows.slice(0, Math.max(1, maxItems)).map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    return {
      symbol: record.symbol,
      name: record.name,
      signal_date: record.signal_date ?? record.end_date,
      strategy: record.strategy,
    };
  });
}

function resolveStrategyDisplayName(taskKey?: string) {
  switch (taskKey) {
    case "strategy.mid_term_accel.daily_scan":
      return "中期加速策略";
    case "strategy.mid_term_reversal_opt.daily_scan":
      return "中期触底反转策略";
    case "strategy.strong_pivot_breakout.daily_scan":
      return "强势枢轴突破策略";
    default:
      return taskKey?.trim() || "Pattern Strategy 策略";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractDateText(value: unknown): string | undefined {
  return extractMarketDateText(value);
}

function extractSignalDateText(row: unknown, preferredField?: string) {
  const record = asRecord(row);
  if (!record) {
    return undefined;
  }
  const candidates = [
    preferredField,
    "signal_date",
    "end_date",
    "date",
    "trade_date",
    "created_at",
  ].filter((entry): entry is string => Boolean(entry));
  for (const key of candidates) {
    const text = extractDateText(record[key]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function resolveNotificationSignalDate(params: {
  runData: Record<string, unknown> | null;
  watch: PatternStrategyAsyncWatch;
  signals: unknown[];
}) {
  const resolved =
    asRecord(params.watch.resolvedWindow) ?? asRecord(params.runData?.resolved_window);
  return (
    extractDateText(resolved?.end_date) ??
    extractDateText(resolved?.endDate) ??
    params.signals.map((signal) => extractSignalDateText(signal)).find(Boolean) ??
    extractDateText(params.runData?.completed_at)
  );
}

function translateClassificationReason(reason: string) {
  const recentFallback = /^signals are outside recent_days=(\d+) and match fallback_count=(\d+)$/;
  const recentMatch = recentFallback.exec(reason);
  if (recentMatch) {
    return "本次返回的是历史信号，不代表今日新增信号。";
  }
  if (reason === "latest_only returned only fallback-sized results without fresh-source metadata") {
    return "本次返回的是历史信号，不代表今日新增信号。";
  }
  if (reason === "no signals returned") {
    return "服务端没有返回可交付信号。";
  }
  if (reason.startsWith("explicit delivery source:")) {
    return "服务端标记本次信号为非新增信号来源。";
  }
  if (reason.startsWith("terminal status ")) {
    return `任务以 ${reason.slice("terminal status ".length)} 状态结束。`;
  }
  return reason;
}

function normalizeTradingPrinciples(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = record?.[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function normalizeDeliveryPolicy(value: unknown): SignalDeliveryPolicy {
  const record = asRecord(value);
  return {
    mode: readString(record, "mode"),
    dateField: readString(record, "date_field") ?? readString(record, "dateField"),
    recentDays: readNumber(record, "recent_days") ?? readNumber(record, "recentDays"),
    fallbackMode: readString(record, "fallback_mode") ?? readString(record, "fallbackMode"),
    fallbackCount: readNumber(record, "fallback_count") ?? readNumber(record, "fallbackCount"),
    maxItems: readNumber(record, "max_items") ?? readNumber(record, "maxItems"),
  };
}

function normalizeDeliveryMeta(value: unknown): SignalDeliveryMeta | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const meta = {
    source: readString(record, "source"),
    mode: readString(record, "mode"),
    windowStart: readString(record, "window_start") ?? readString(record, "windowStart"),
    windowEnd: readString(record, "window_end") ?? readString(record, "windowEnd"),
    usedFallback: readBoolean(record, "used_fallback") ?? readBoolean(record, "usedFallback"),
  };
  return Object.values(meta).some((entry) => entry !== undefined) ? meta : undefined;
}

function extractDeliveryMeta(
  signalData: unknown,
  signalMeta: unknown,
): SignalDeliveryMeta | undefined {
  const data = asRecord(signalData);
  return (
    normalizeDeliveryMeta(data?.delivery) ??
    normalizeDeliveryMeta(data?.signal_delivery) ??
    normalizeDeliveryMeta(data?.signalDelivery) ??
    normalizeDeliveryMeta(signalMeta)
  );
}

function extractSignalRows(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  const record = asRecord(data);
  for (const key of ["signals", "rows", "items", "results", "data"]) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function extractRowMarketDate(row: unknown, preferredField?: string): string | undefined {
  const record = asRecord(row);
  if (!record) {
    return undefined;
  }
  const candidates = [
    preferredField,
    "signal_date",
    "end_date",
    "date",
    "trade_date",
    "created_at",
  ].filter((entry): entry is string => Boolean(entry));
  for (const key of candidates) {
    const parsed = extractMarketDateText(record[key]);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function extractReferenceDate(
  runData: Record<string, unknown> | null,
  watch: PatternStrategyAsyncWatch,
) {
  const resolved = asRecord(watch.resolvedWindow) ?? asRecord(runData?.resolved_window);
  return (
    extractMarketDateText(resolved?.end_date) ??
    extractMarketDateText(resolved?.endDate) ??
    extractMarketDateText(runData?.completed_at) ??
    extractMarketDateText(new Date())!
  );
}

function findExplicitDeliverySource(...values: unknown[]): string | undefined {
  for (const value of values) {
    const record = asRecord(value);
    const direct =
      readString(record, "delivery_source") ??
      readString(record, "signal_delivery_source") ??
      readString(record, "source") ??
      readString(record, "deliverySource");
    if (direct) {
      return direct.toLowerCase();
    }
    const nested = asRecord(record?.signal_delivery) ?? asRecord(record?.signalDelivery);
    const nestedSource =
      readString(nested, "source") ??
      readString(nested, "delivery_source") ??
      readString(nested, "mode_source");
    if (nestedSource) {
      return nestedSource.toLowerCase();
    }
  }
  return undefined;
}

function classifySignals(params: {
  rows: unknown[];
  signalData: unknown;
  signalMeta: unknown;
  runData: Record<string, unknown> | null;
  watch: PatternStrategyAsyncWatch;
  policy: SignalDeliveryPolicy;
}): SignalDeliveryClassification {
  if (params.rows.length === 0) {
    return { kind: "none", reason: "no signals returned" };
  }
  const delivery = extractDeliveryMeta(params.signalData, params.signalMeta);
  if (delivery?.usedFallback === true) {
    return { kind: "fallback_only", reason: "server delivery used fallback" };
  }
  if (delivery?.usedFallback === false) {
    const detail = delivery.windowEnd ? ` window_end=${delivery.windowEnd}` : "";
    return { kind: "actionable", reason: `server delivery recent window${detail}` };
  }
  const explicitSource = findExplicitDeliverySource(
    params.signalData,
    params.signalMeta,
    params.runData,
  );
  if (explicitSource?.includes("fallback")) {
    return { kind: "fallback_only", reason: `explicit delivery source: ${explicitSource}` };
  }
  if (
    explicitSource &&
    (explicitSource.includes("recent") ||
      explicitSource.includes("fresh") ||
      explicitSource.includes("primary"))
  ) {
    return { kind: "actionable", reason: `explicit delivery source: ${explicitSource}` };
  }

  const fallbackCount = Math.max(0, Math.floor(params.policy.fallbackCount ?? 0));
  const recentDays = Math.max(0, Math.floor(params.policy.recentDays ?? 0));
  const hasFallbackPolicy = Boolean(params.policy.fallbackMode?.trim()) && fallbackCount > 0;
  const referenceDate = extractReferenceDate(params.runData, params.watch);
  const rowDates = params.rows
    .map((row) => extractRowMarketDate(row, params.policy.dateField))
    .filter((entry): entry is string => typeof entry === "string");
  if (hasFallbackPolicy && rowDates.length > 0 && recentDays > 0) {
    const newestSignalDate = rowDates.toSorted().at(-1);
    if (
      newestSignalDate &&
      isOutsideRecentMarketWindow({
        referenceDate,
        signalDate: newestSignalDate,
        recentDays,
      }) &&
      params.rows.length <= fallbackCount
    ) {
      return {
        kind: "fallback_only",
        reason: `signals are outside recent_days=${recentDays} and match fallback_count=${fallbackCount}`,
      };
    }
  }
  if (
    hasFallbackPolicy &&
    params.rows.length <= fallbackCount &&
    params.policy.mode === "latest_only"
  ) {
    return {
      kind: "fallback_only",
      reason: "latest_only returned only fallback-sized results without fresh-source metadata",
    };
  }
  return { kind: "actionable", reason: "signals appear fresh or source metadata is unavailable" };
}

export function buildAsyncCompletionEvent(params: {
  watch: PatternStrategyAsyncWatch;
  runData: Record<string, unknown> | null;
  signals: unknown[];
  tradingPrinciples?: string[];
}) {
  const tradingPrinciples = normalizeTradingPrinciples(params.tradingPrinciples);
  const signalPreview = summarizeSignals(params.signals, params.signals.length || 1);
  const lines = [
    `${ASYNC_COMPLETION_EVENT_PREFIX} Pattern Strategy run completed.`,
    "This is an async completion callback, not a new user request.",
    "Do not call messaging delivery tools from this callback; produce the final reply only and the async watcher will deliver it.",
    "Do not narrate progress, tool usage, or intermediate analysis. Return exactly one final Chinese summary for Feishu.",
    `job_id: ${params.watch.jobId}`,
    params.watch.taskKey ? `task_key: ${params.watch.taskKey}` : null,
    `strategy_name_zh: ${resolveStrategyDisplayName(params.watch.taskKey)}`,
    params.watch.requestKey ? `request_key: ${params.watch.requestKey}` : null,
    params.watch.runLabel ? `run_label: ${params.watch.runLabel}` : null,
    params.runData?.status ? `status: ${String(params.runData.status)}` : null,
    params.runData?.strategy ? `strategy: ${String(params.runData.strategy)}` : null,
    params.runData?.progress != null ? `progress: ${String(params.runData.progress)}` : null,
    params.watch.enrichSignals
      ? [
          "Action: prepare the final user-facing summary in Chinese.",
          buildCanslimEnrichmentContract(),
        ].join("\n")
      : [
          "Action: prepare the final user-facing summary in Chinese. Use the Chinese strategy name, call signal_date/end_date 信号日, and keep the formal strategy signal authoritative.",
          buildStrategyConstructionConfidentialityRule(),
        ].join("\n"),
    `market_timezone: ${MARKET_TIMEZONE}`,
    tradingPrinciples.length > 0
      ? "Trading principles: every fresh/actionable signal summary must include and apply these user trading principles as a final interpretation and risk-control layer only. Do not use them to delete, hide, or replace formal Pattern Strategy signals."
      : null,
    tradingPrinciples.length > 0
      ? `trading_principles_json: ${JSON.stringify(tradingPrinciples)}`
      : null,
    `signal_count: ${params.signals.length}`,
    "signal_preview_json:",
    JSON.stringify(signalPreview, null, 2),
  ].filter(Boolean);
  return lines.join("\n");
}

async function fetchRunStatus(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  jobId: string;
  logger?: OpenClawPluginApi["logger"];
  logContext?: {
    taskKey?: string;
    idempotencyKey?: string;
    source?: string;
    requestedBy?: string;
    traceId?: string;
    triggerType?: string;
  };
}) {
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "strategy.get_run",
    args: { job_id: params.jobId },
    logger: params.logger,
    logContext: params.logContext,
  });
  const result = await formatPatternStrategyResult({
    remoteToolName: "strategy.get_run",
    payload,
  });
  return (result.details?.data ?? null) as Record<string, unknown> | null;
}

async function fetchSignals(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  jobId: string;
  limit: number;
  logger?: OpenClawPluginApi["logger"];
  logContext?: {
    taskKey?: string;
    idempotencyKey?: string;
    source?: string;
    requestedBy?: string;
    traceId?: string;
    triggerType?: string;
  };
}): Promise<SignalFetchResult> {
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "strategy.get_signals",
    args: { job_id: params.jobId, limit: params.limit, order: "desc" },
    logger: params.logger,
    logContext: params.logContext,
  });
  const result = await formatPatternStrategyResult({
    remoteToolName: "strategy.get_signals",
    payload,
  });
  const data = result.details?.data;
  return {
    rows: extractSignalRows(data),
    data,
    meta: result.details?.remote?.meta,
  };
}

async function fetchIndiceStatus(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  jobId: string;
}) {
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "indice.refresh_get",
    args: { job_id: params.jobId },
  });
  const result = await formatPatternStrategyResult({
    remoteToolName: "indice.refresh_get",
    payload,
  });
  return (result.details?.data ?? null) as Record<string, unknown> | null;
}

async function fetchIndiceErrors(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  jobId: string;
  limit: number;
}) {
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "indice.refresh_errors",
    args: { job_id: params.jobId, limit: params.limit },
  });
  const result = await formatPatternStrategyResult({
    remoteToolName: "indice.refresh_errors",
    payload,
  });
  const data = result.details?.data;
  return Array.isArray(data) ? data : [];
}

async function fetchTaskDeliveryPolicy(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  taskKey?: string;
  logger?: OpenClawPluginApi["logger"];
  logContext?: {
    taskKey?: string;
    idempotencyKey?: string;
    source?: string;
    requestedBy?: string;
    traceId?: string;
    triggerType?: string;
  };
}): Promise<SignalDeliveryPolicy> {
  if (!params.taskKey) {
    return {};
  }
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "strategy.task_describe",
    args: { task_key: params.taskKey },
    logger: params.logger,
    logContext: params.logContext,
  });
  const result = await formatPatternStrategyResult({
    remoteToolName: "strategy.task_describe",
    payload,
  });
  const data = asRecord(result.details?.data);
  return normalizeDeliveryPolicy(
    data?.signal_delivery ?? asRecord(data?.defaults)?.signal_delivery,
  );
}

export const __testing = {
  buildSignalFetchFailureNotification,
  buildFeishuSignalTablePayload,
  classifySignals,
  fetchRunStatus,
  processPendingWatch,
};

function normalizeOutboundChannel(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const channel = value.trim().toLowerCase();
  if (!channel || channel === "last" || channel === "unknown" || channel === "none") {
    return undefined;
  }
  return channel as Exclude<Parameters<typeof deliverOutboundPayloads>[0]["channel"], "none">;
}

function formatSignalList(signals: unknown[]) {
  const rows = summarizeSignals(signals, 8);
  if (rows.length === 0) {
    return "-";
  }
  return rows
    .map((entry, index) => {
      const record = asRecord(entry);
      const symbol = record?.symbol ? String(record.symbol) : "unknown";
      const name = record?.name ? `｜${String(record.name)}` : "";
      const signalDate = extractSignalDateText(entry);
      const date = signalDate ? `｜信号日 ${signalDate}` : "";
      return `${index + 1}. ${symbol}${name}${date}`;
    })
    .join("\n");
}

function trimForCell(value: unknown, fallback = "-") {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!text) {
    return fallback;
  }
  const singleLine = text.replace(/\s+/g, " ");
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}...` : singleLine;
}

function readFirstString(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function resolveSignalIndustry(record: Record<string, unknown> | null) {
  return readFirstString(record, [
    "industry",
    "industry_name",
    "industryName",
    "sector",
    "所属行业",
    "shenwan_industry",
    "sw_industry",
    "sw_l1",
  ]);
}

function resolveSignalPoint(record: Record<string, unknown> | null, strategyName: string) {
  return (
    readFirstString(record, [
      "comment",
      "note",
      "summary",
      "reason",
      "signal_reason",
      "signalReason",
      "description",
      "pattern",
    ]) ?? `${strategyName}触发，需结合量价延续和基本面补充确认。`
  );
}

function buildFeishuSignalTablePayload(params: {
  watch: PatternStrategyAsyncWatch;
  runData: Record<string, unknown> | null;
  signals: unknown[];
}): ReplyPayload | undefined {
  const rows = params.signals.slice(0, 10).map((signal) => {
    const record = asRecord(signal);
    return {
      symbol: trimForCell(record?.symbol ?? record?.ts_code ?? record?.code),
      name: trimForCell(record?.name ?? record?.stock_name ?? record?.security_name),
      industry: trimForCell(resolveSignalIndustry(record)),
      signal_date: trimForCell(extractSignalDateText(signal)),
      point: trimForCell(
        resolveSignalPoint(record, resolveStrategyDisplayName(params.watch.taskKey)),
      ),
    };
  });
  if (rows.length === 0) {
    return undefined;
  }
  const strategyName = resolveStrategyDisplayName(params.watch.taskKey);
  const signalDate = resolveNotificationSignalDate({
    runData: params.runData,
    watch: params.watch,
    signals: params.signals,
  });
  const title = `${strategyName}｜最新信号`;
  const fallbackText = rows
    .map(
      (row) =>
        `${row.symbol} ${row.name} 行业:${row.industry} 信号日:${row.signal_date} 要点:${row.point}`,
    )
    .join("\n");

  return {
    text: fallbackText,
    channelData: {
      feishu: {
        card: {
          schema: "2.0",
          config: { wide_screen_mode: true },
          header: {
            template: "blue",
            title: { tag: "plain_text", content: title },
          },
          body: {
            elements: [
              {
                tag: "markdown",
                content: signalDate
                  ? `**信号日：${signalDate}**`
                  : `**Job ID：${params.watch.jobId}**`,
              },
              {
                tag: "table",
                element_id: "signal_table",
                page_size: Math.min(10, Math.max(1, rows.length)),
                row_height: "auto",
                freeze_first_column: true,
                header_style: {
                  text_align: "left",
                  text_size: "normal",
                  background_style: "grey",
                  text_color: "default",
                  bold: true,
                  lines: 1,
                },
                columns: [
                  { name: "symbol", display_name: "代码", data_type: "text", width: "100px" },
                  { name: "name", display_name: "名称", data_type: "text", width: "100px" },
                  { name: "industry", display_name: "行业", data_type: "text", width: "120px" },
                  {
                    name: "signal_date",
                    display_name: "信号日",
                    data_type: "text",
                    width: "110px",
                  },
                  { name: "point", display_name: "要点", data_type: "text", width: "auto" },
                ],
                rows,
              },
            ],
          },
        },
      },
    },
  };
}

type DeliveryWatch = {
  jobId: string;
  sessionKey: string;
  agentId: string;
  deliverySnapshot?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
};

async function deliverDeterministicUpdate(params: {
  api: OpenClawPluginApi;
  watch: DeliveryWatch;
  text: string;
}) {
  const channel = normalizeOutboundChannel(params.watch.deliverySnapshot?.channel);
  const to = params.watch.deliverySnapshot?.to?.trim();
  if (!channel || !to) {
    return "not-requested" as const;
  }
  try {
    const results = await deliverOutboundPayloads({
      cfg: params.api.config,
      channel,
      to,
      accountId: params.watch.deliverySnapshot?.accountId,
      payloads: [{ text: params.text }],
      session: buildOutboundSessionContext({
        cfg: params.api.config,
        agentId: params.watch.agentId,
        sessionKey: params.watch.sessionKey,
      }),
      identity: resolveAgentOutboundIdentity(params.api.config, params.watch.agentId),
      bestEffort: true,
      mirror: {
        sessionKey: params.watch.sessionKey,
        agentId: params.watch.agentId,
        text: params.text,
      },
    });
    return results.length > 0 ? ("delivered" as const) : ("not-delivered" as const);
  } catch (error) {
    params.api.logger.warn(
      `pattern-strategy deterministic delivery failed for ${params.watch.jobId}: ${String(error)}`,
    );
    return "not-delivered" as const;
  }
}

function buildIndiceTerminalNotification(params: {
  watch: IndiceRefreshAsyncWatch;
  runData: Record<string, unknown> | null;
  status: string;
  errors: unknown[];
}) {
  const ok = params.status === "completed" || params.status === "partial_failed";
  const lines = [
    ok ? "Pattern Strategy 板块指数刷新已执行完成。" : "Pattern Strategy 板块指数刷新执行失败。",
    `job_id: ${params.watch.jobId}`,
    params.watch.requestKey ? `request_key: ${params.watch.requestKey}` : null,
    params.watch.runLabel ? `run_label: ${params.watch.runLabel}` : null,
    params.watch.source ? `source: ${params.watch.source}` : null,
    `status: ${params.status}`,
    params.runData?.stage ? `stage: ${String(params.runData.stage)}` : null,
    params.runData?.progress != null ? `progress: ${String(params.runData.progress)}` : null,
    params.runData?.start_date ? `start_date: ${String(params.runData.start_date)}` : null,
    params.runData?.end_date ? `end_date: ${String(params.runData.end_date)}` : null,
    params.runData?.dimensions ? `dimensions: ${JSON.stringify(params.runData.dimensions)}` : null,
    params.runData?.total_indices != null
      ? `total_indices: ${String(params.runData.total_indices)}`
      : null,
    params.runData?.completed_indices != null
      ? `completed_indices: ${String(params.runData.completed_indices)}`
      : null,
    params.runData?.success_indices != null
      ? `success_indices: ${String(params.runData.success_indices)}`
      : null,
    params.runData?.failed_indices != null
      ? `failed_indices: ${String(params.runData.failed_indices)}`
      : null,
    params.runData?.turnover_status
      ? `turnover_status: ${String(params.runData.turnover_status)}`
      : null,
    params.runData?.message ? `message: ${String(params.runData.message)}` : null,
    `error_count: ${params.errors.length}`,
    params.errors.length > 0
      ? `error_preview_json: ${JSON.stringify(params.errors.slice(0, 5))}`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function normalizeReplyPayloads(value: ReplyPayload | ReplyPayload[] | undefined): ReplyPayload[] {
  if (!value) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter((payload) => {
    return Boolean(
      payload &&
      !payload.isReasoning &&
      (payload.text?.trim() || payload.mediaUrl || payload.mediaUrls?.length),
    );
  });
}

function resolveCallbackSessionKey(watch: PatternStrategyAsyncWatch) {
  return `agent:${watch.agentId}:async:pattern-strategy:${watch.jobId}`;
}

function buildWatchMcpLogContext(watch: PatternStrategyAsyncWatch) {
  return {
    taskKey: watch.taskKey,
    idempotencyKey: watch.idempotencyKey ?? watch.requestKey,
    source: watch.source,
    requestedBy: watch.requestedBy,
    traceId: watch.traceId,
    triggerType: watch.triggerType,
  };
}

async function runActionableSignalCallback(params: {
  api: OpenClawPluginApi;
  watch: PatternStrategyAsyncWatch;
  eventText: string;
  runData: Record<string, unknown> | null;
  signals: unknown[];
}) {
  const channel = normalizeOutboundChannel(params.watch.deliverySnapshot?.channel);
  const to = params.watch.deliverySnapshot?.to?.trim();
  if (!channel || !to) {
    return {
      deliveryStatus: "not-requested" as const,
      callbackSessionKey: resolveCallbackSessionKey(params.watch),
    };
  }

  const callbackSessionKey = resolveCallbackSessionKey(params.watch);
  await appendAgentInteractionAuditRecord({
    kind: "async_watch_callback_started",
    requesterSessionKey: params.watch.sessionKey,
    sessionKey: callbackSessionKey,
    agentId: params.watch.agentId,
    jobId: params.watch.jobId,
    status: "running",
    summary: "pattern-strategy actionable async callback started",
    data: {
      taskKey: params.watch.taskKey,
      requestKey: params.watch.requestKey,
      runLabel: params.watch.runLabel,
      deliveryChannel: channel,
      deliveryTo: to,
    },
  });

  const reply = await getReplyFromConfig(
    {
      Body: params.eventText,
      BodyForAgent: params.eventText,
      RawBody: params.eventText,
      CommandBody: params.eventText,
      SessionKey: callbackSessionKey,
      OriginatingChannel: channel,
      OriginatingTo: to,
      AccountId: params.watch.deliverySnapshot?.accountId,
      Provider: "async-event",
    },
    {
      suppressTyping: true,
      typingPolicy: "system_event",
      disableBlockStreaming: true,
      timeoutOverrideSeconds: 900,
      suppressToolErrorWarnings: true,
    },
    params.api.config,
  );
  const payloads = normalizeReplyPayloads(reply);
  const signalTablePayload =
    channel === "feishu"
      ? buildFeishuSignalTablePayload({
          watch: params.watch,
          runData: params.runData,
          signals: params.signals,
        })
      : undefined;
  const deliveryPayloads = signalTablePayload ? [signalTablePayload, ...payloads] : payloads;
  if (deliveryPayloads.length === 0) {
    return { deliveryStatus: "not-delivered" as const, callbackSessionKey };
  }

  const results = await deliverOutboundPayloads({
    cfg: params.api.config,
    channel,
    to,
    accountId: params.watch.deliverySnapshot?.accountId,
    payloads: deliveryPayloads,
    session: buildOutboundSessionContext({
      cfg: params.api.config,
      agentId: params.watch.agentId,
      sessionKey: callbackSessionKey,
    }),
    identity: resolveAgentOutboundIdentity(params.api.config, params.watch.agentId),
    bestEffort: true,
    mirror: {
      sessionKey: callbackSessionKey,
      agentId: params.watch.agentId,
      text: deliveryPayloads
        .map((payload) => payload.text)
        .filter((text): text is string => Boolean(text?.trim()))
        .join("\n\n"),
    },
  });
  return {
    deliveryStatus: results.length > 0 ? ("delivered" as const) : ("not-delivered" as const),
    callbackSessionKey,
  };
}

export function buildTerminalNotification(params: {
  watch: PatternStrategyAsyncWatch;
  runData: Record<string, unknown> | null;
  status: string;
  classification: SignalDeliveryClassification;
  signals: unknown[];
}) {
  const strategyName = resolveStrategyDisplayName(params.watch.taskKey);
  const signalDate = resolveNotificationSignalDate({
    runData: params.runData,
    watch: params.watch,
    signals: params.signals,
  });
  const baseLines = [
    `策略：${strategyName}`,
    `任务状态：${params.status === "succeeded" ? "成功" : params.status}`,
    `Job ID：${params.watch.jobId}`,
    signalDate ? `信号日：${signalDate}` : null,
  ];
  if (params.status !== "succeeded") {
    return [
      "Pattern Strategy 策略任务已结束。",
      "",
      ...baseLines,
      params.runData?.message ? "服务端消息：已省略内部细节。" : null,
      "说明：本次未调用 DS 做资讯检索和因子包装。",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (params.classification.kind === "none") {
    return [
      "Pattern Strategy 策略任务已完成。",
      "",
      ...baseLines,
      "",
      "本次没有返回可交付策略信号。",
      `原因：${translateClassificationReason(params.classification.reason)}`,
      "说明：本次未调用 DS 做资讯检索和因子包装。",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "Pattern Strategy 策略任务已完成。",
    "",
    ...baseLines,
    "",
    "本次没有产生新的近期策略信号；以下为系统拉取的历史信号，仅用于确认任务执行完成，不代表今日新增信号。",
    `原因：${translateClassificationReason(params.classification.reason)}`,
    "",
    "历史信号：",
    formatSignalList(params.signals),
    "",
    "说明：本次未调用 DS 做资讯检索和因子包装。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSignalFetchFailureNotification(params: {
  watch: PatternStrategyAsyncWatch;
  runData: Record<string, unknown> | null;
  error: unknown;
}) {
  const strategyName = resolveStrategyDisplayName(params.watch.taskKey);
  const isTimeout = String(params.error).toLowerCase().includes("timed out");
  return [
    "Pattern Strategy 策略任务已完成，但信号结果暂时拉取失败。",
    "",
    `策略：${strategyName}`,
    "任务状态：成功",
    `Job ID：${params.watch.jobId}`,
    params.runData?.completed_at ? `完成时间：${String(params.runData.completed_at)}` : null,
    "",
    `原因：strategy.get_signals ${isTimeout ? "超时" : "失败"}，尚未拿到可交付信号列表。`,
    "处理：watcher 会继续在后台重试；后端恢复后会自动拉取正式信号并触发 CANSLIM enrichment 推送。",
    "说明：本次尚未调用 DS 做资讯检索和因子包装。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleSignalFetchFailure(params: {
  api: OpenClawPluginApi;
  stateDir: string;
  watch: PatternStrategyAsyncWatch;
  runData: Record<string, unknown> | null;
  remoteStatus: string;
  error: unknown;
}) {
  params.api.logger.warn(
    `pattern-strategy signal fetch failed for ${params.watch.jobId}: ${String(params.error)}`,
  );
  const now = Date.now();
  const shouldNotify = !params.watch.signalFetchFailureNotifiedAt;
  const deliveryStatus = shouldNotify
    ? await deliverDeterministicUpdate({
        api: params.api,
        watch: params.watch,
        text: buildSignalFetchFailureNotification({
          watch: params.watch,
          runData: params.runData,
          error: params.error,
        }),
      })
    : ("not-requested" as const);

  await appendAgentInteractionAuditRecord({
    kind: "async_watch_failed",
    requesterSessionKey: params.watch.sessionKey,
    sessionKey: params.watch.sessionKey,
    agentId: params.watch.agentId,
    jobId: params.watch.jobId,
    status: "signal_fetch_failed",
    summary: "pattern-strategy async watch signal fetch failed after terminal success",
    data: {
      taskKey: params.watch.taskKey,
      requestKey: params.watch.requestKey,
      runLabel: params.watch.runLabel,
      remoteStatus: params.remoteStatus,
      error: String(params.error),
      deliveryStatus,
      notified: shouldNotify,
    },
  });
  await updateAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
    ...existing,
    lastRemoteStatus: params.remoteStatus,
    updatedAt: now,
    lastError: String(params.error),
    signalFetchFailureNotifiedAt:
      existing.signalFetchFailureNotifiedAt ?? (shouldNotify ? now : undefined),
  }));
}

async function processPendingWatch(params: {
  api: OpenClawPluginApi;
  stateDir: string;
  watch: PatternStrategyAsyncWatch;
}) {
  const runData = await fetchRunStatus({
    pluginConfig: params.api.pluginConfig as PatternStrategyPluginConfig | undefined,
    jobId: params.watch.jobId,
    logger: params.api.logger,
    logContext: buildWatchMcpLogContext(params.watch),
  });
  const remoteStatus = normalizeStatus(runData?.status);
  if (!STRATEGY_TERMINAL_STATUSES.has(remoteStatus)) {
    await appendAgentInteractionAuditRecord({
      kind: "async_watch_progress",
      requesterSessionKey: params.watch.sessionKey,
      sessionKey: params.watch.sessionKey,
      agentId: params.watch.agentId,
      jobId: params.watch.jobId,
      status: remoteStatus,
      summary: "pattern-strategy async watch observed a non-terminal status",
      data: {
        taskKey: params.watch.taskKey,
        requestKey: params.watch.requestKey,
      },
    });
    await updateAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
      ...existing,
      lastRemoteStatus: remoteStatus,
      lastError: undefined,
      updatedAt: Date.now(),
    }));
    return;
  }

  let signalResult: SignalFetchResult;
  if (remoteStatus === "succeeded") {
    try {
      signalResult = await fetchSignals({
        pluginConfig: params.api.pluginConfig as PatternStrategyPluginConfig | undefined,
        jobId: params.watch.jobId,
        limit: params.watch.maxSignals,
        logger: params.api.logger,
        logContext: buildWatchMcpLogContext(params.watch),
      });
    } catch (error) {
      await handleSignalFetchFailure({
        api: params.api,
        stateDir: params.stateDir,
        watch: params.watch,
        runData,
        remoteStatus,
        error,
      });
      return;
    }
  } else {
    signalResult = { rows: [], data: [], meta: undefined };
  }
  const policy =
    remoteStatus === "succeeded"
      ? await fetchTaskDeliveryPolicy({
          pluginConfig: params.api.pluginConfig as PatternStrategyPluginConfig | undefined,
          taskKey: params.watch.taskKey,
          logger: params.api.logger,
          logContext: buildWatchMcpLogContext(params.watch),
        }).catch((error) => {
          params.api.logger.warn(
            `pattern-strategy task policy lookup failed for ${params.watch.taskKey}: ${String(
              error,
            )}`,
          );
          return {};
        })
      : {};
  const classification =
    remoteStatus === "succeeded"
      ? classifySignals({
          rows: signalResult.rows,
          signalData: signalResult.data,
          signalMeta: signalResult.meta,
          runData,
          watch: params.watch,
          policy,
        })
      : ({
          kind: "terminal_error",
          reason: `terminal status ${remoteStatus}`,
        } as const);
  if (classification.kind !== "actionable") {
    const deliveryStatus = await deliverDeterministicUpdate({
      api: params.api,
      watch: params.watch,
      text: buildTerminalNotification({
        watch: params.watch,
        runData,
        status: remoteStatus,
        classification:
          classification.kind === "terminal_error"
            ? { kind: "none", reason: classification.reason }
            : classification,
        signals: signalResult.rows,
      }),
    });
    await appendAgentInteractionAuditRecord({
      kind: "async_watch_completed",
      requesterSessionKey: params.watch.sessionKey,
      sessionKey: params.watch.sessionKey,
      agentId: params.watch.agentId,
      jobId: params.watch.jobId,
      status: remoteStatus,
      summary: "pattern-strategy async watch completed without DS enrichment",
      data: {
        taskKey: params.watch.taskKey,
        requestKey: params.watch.requestKey,
        runLabel: params.watch.runLabel,
        signalCount: signalResult.rows.length,
        signalDeliveryKind:
          classification.kind === "terminal_error" ? "terminal_error" : classification.kind,
        classificationReason: classification.reason,
        deliveryStatus,
        dsInvoked: false,
      },
    });
    await updateAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
      ...existing,
      lastRemoteStatus: remoteStatus,
      signalDeliveryKind:
        classification.kind === "terminal_error" ? "terminal_error" : classification.kind,
      dsInvoked: false,
      deliveryStatus,
      lastError: undefined,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    }));
    return;
  }
  const eventText = buildAsyncCompletionEvent({
    watch: params.watch,
    runData,
    signals: summarizeSignals(signalResult.rows, params.watch.maxSignals),
    tradingPrinciples: (params.api.pluginConfig as PatternStrategyPluginConfig | undefined)
      ?.tradingPrinciples,
  });
  const callbackResult = await runActionableSignalCallback({
    api: params.api,
    watch: params.watch,
    eventText,
    runData,
    signals: signalResult.rows,
  });
  await appendAgentInteractionAuditRecord({
    kind: "async_watch_completed",
    requesterSessionKey: params.watch.sessionKey,
    sessionKey: callbackResult.callbackSessionKey,
    agentId: params.watch.agentId,
    jobId: params.watch.jobId,
    status: remoteStatus,
    summary: "pattern-strategy async watch completed and ran actionable callback",
    data: {
      taskKey: params.watch.taskKey,
      requestKey: params.watch.requestKey,
      runLabel: params.watch.runLabel,
      signalCount: signalResult.rows.length,
      signalDeliveryKind: classification.kind,
      classificationReason: classification.reason,
      dsInvoked: true,
      wakeMode: params.watch.wakeMode,
      callbackDeliveryStatus: callbackResult.deliveryStatus,
    },
  });
  await updateAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
    ...existing,
    lastRemoteStatus: remoteStatus,
    signalDeliveryKind: classification.kind,
    dsInvoked: true,
    callbackDeliveryStatus: callbackResult.deliveryStatus,
    callbackSessionKey: callbackResult.callbackSessionKey,
    lastError: undefined,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  }));
}

async function processIndiceWatch(params: {
  api: OpenClawPluginApi;
  stateDir: string;
  watch: IndiceRefreshAsyncWatch;
}) {
  const runData = await fetchIndiceStatus({
    pluginConfig: params.api.pluginConfig as PatternStrategyPluginConfig | undefined,
    jobId: params.watch.jobId,
  });
  const remoteStatus = normalizeStatus(runData?.status);
  if (!INDICE_TERMINAL_STATUSES.has(remoteStatus)) {
    await appendAgentInteractionAuditRecord({
      kind: "async_watch_progress",
      requesterSessionKey: params.watch.sessionKey,
      sessionKey: params.watch.sessionKey,
      agentId: params.watch.agentId,
      jobId: params.watch.jobId,
      status: remoteStatus,
      summary: "pattern-strategy indice async watch observed a non-terminal status",
      data: {
        source: params.watch.source,
        requestKey: params.watch.requestKey,
        stage: runData?.stage,
        progress: runData?.progress,
      },
    });
    await updateIndiceAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
      ...existing,
      lastRemoteStatus: remoteStatus,
      lastError: undefined,
      updatedAt: Date.now(),
    }));
    return;
  }

  const failedIndices =
    typeof runData?.failed_indices === "number" && Number.isFinite(runData.failed_indices)
      ? runData.failed_indices
      : 0;
  const errors =
    failedIndices > 0
      ? await fetchIndiceErrors({
          pluginConfig: params.api.pluginConfig as PatternStrategyPluginConfig | undefined,
          jobId: params.watch.jobId,
          limit: 20,
        })
      : [];
  const deliveryStatus = await deliverDeterministicUpdate({
    api: params.api,
    watch: params.watch,
    text: buildIndiceTerminalNotification({
      watch: params.watch,
      runData,
      status: remoteStatus,
      errors,
    }),
  });
  await appendAgentInteractionAuditRecord({
    kind: "async_watch_completed",
    requesterSessionKey: params.watch.sessionKey,
    sessionKey: params.watch.sessionKey,
    agentId: params.watch.agentId,
    jobId: params.watch.jobId,
    status: remoteStatus,
    summary: "pattern-strategy indice async watch completed and delivered terminal status",
    data: {
      source: params.watch.source,
      requestKey: params.watch.requestKey,
      runLabel: params.watch.runLabel,
      failedIndices,
      errorCount: errors.length,
      deliveryStatus,
      llmInvoked: false,
    },
  });
  await updateIndiceAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
    ...existing,
    lastRemoteStatus: remoteStatus,
    deliveryStatus,
    lastError: undefined,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  }));
}

export function createPatternStrategyAsyncWatchService(
  api: OpenClawPluginApi,
): OpenClawPluginService {
  const state: WatchServiceState = {
    stopRequested: false,
    timer: null,
    running: false,
  };

  const schedule = () => {
    if (state.stopRequested || !state.stateDir) {
      return;
    }
    const delayMs = resolvePollMs(api.pluginConfig as PatternStrategyPluginConfig | undefined);
    state.timer = setTimeout(async () => {
      state.timer = null;
      if (state.stopRequested || state.running || !state.stateDir) {
        schedule();
        return;
      }
      state.running = true;
      try {
        const watches = await listAsyncWatches(state.stateDir);
        for (const watch of watches) {
          if (watch.completedAt) {
            continue;
          }
          try {
            await processPendingWatch({ api, stateDir: state.stateDir, watch });
          } catch (error) {
            api.logger.warn(
              `pattern-strategy async watch failed for ${watch.jobId}: ${String(error)}`,
            );
            await appendAgentInteractionAuditRecord({
              kind: "async_watch_failed",
              requesterSessionKey: watch.sessionKey,
              sessionKey: watch.sessionKey,
              agentId: watch.agentId,
              jobId: watch.jobId,
              status: "failed",
              summary: "pattern-strategy async watch poll failed",
              data: {
                taskKey: watch.taskKey,
                error: String(error),
              },
            });
            await updateAsyncWatch(state.stateDir, watch.jobId, (existing) => ({
              ...existing,
              updatedAt: Date.now(),
              lastError: String(error),
            }));
          }
        }
        const indiceWatches = await listIndiceAsyncWatches(state.stateDir);
        for (const watch of indiceWatches) {
          if (watch.completedAt) {
            continue;
          }
          try {
            await processIndiceWatch({ api, stateDir: state.stateDir, watch });
          } catch (error) {
            api.logger.warn(
              `pattern-strategy indice async watch failed for ${watch.jobId}: ${String(error)}`,
            );
            await appendAgentInteractionAuditRecord({
              kind: "async_watch_failed",
              requesterSessionKey: watch.sessionKey,
              sessionKey: watch.sessionKey,
              agentId: watch.agentId,
              jobId: watch.jobId,
              status: "failed",
              summary: "pattern-strategy indice async watch poll failed",
              data: {
                source: watch.source,
                requestKey: watch.requestKey,
                error: String(error),
              },
            });
            await updateIndiceAsyncWatch(state.stateDir, watch.jobId, (existing) => ({
              ...existing,
              updatedAt: Date.now(),
              lastError: String(error),
            }));
          }
        }
      } finally {
        state.running = false;
        schedule();
      }
    }, delayMs);
    state.timer.unref?.();
  };

  return {
    id: "pattern-strategy-async-watch",
    async start(ctx) {
      state.stopRequested = false;
      state.stateDir = ctx.stateDir;
      schedule();
      api.logger.info("pattern-strategy async watch service started");
    },
    async stop() {
      state.stopRequested = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      api.logger.info("pattern-strategy async watch service stopped");
    },
  };
}
