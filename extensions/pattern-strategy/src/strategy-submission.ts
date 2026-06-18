import type { PatternStrategyAsyncWatch } from "./async-watch-store.js";
import { extractMarketDateText, type MarketDateText } from "./model-boundary-harness.js";

export const STRATEGY_TERMINAL_STATUSES = new Set<string>([
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "timeout",
]);

export const STRATEGY_TRIGGER_TYPES = new Set<string>([
  "cron",
  "gateway_recovery",
  "manual",
  "retry",
]);

export type StrategyTriggerType = "cron" | "gateway_recovery" | "manual" | "retry";

export type StrategyTaskRunSubmission = {
  taskKey: string;
  idempotencyKey: string;
  source: string;
  requestedBy: string;
  traceId: string;
  triggerType: StrategyTriggerType;
  marketDate?: MarketDateText;
};

const CRON_TASK_ALIASES: Record<string, string> = {
  "strategy.mid_term_accel.daily_scan": "mid-term-accel",
  "strategy.mid_term_reversal_opt.daily_scan": "mid-term-reversal-opt",
  "strategy.strong_pivot_breakout.daily_scan": "strong-pivot-breakout",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = readString(record, key);
  if (!value) {
    throw new Error(`strategy_task_run requires ${key}`);
  }
  return value;
}

export function normalizeStrategyStatus(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "unknown";
}

export function isStrategyTerminalStatus(value: unknown) {
  return STRATEGY_TERMINAL_STATUSES.has(normalizeStrategyStatus(value));
}

export function extractIdempotencyMarketDate(value: unknown): MarketDateText | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return extractMarketDateText(value);
}

function extractOverrideMarketDate(value: unknown): MarketDateText | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct =
    extractMarketDateText(record.end_date) ??
    extractMarketDateText(record.endDate) ??
    extractMarketDateText(record.trade_date) ??
    extractMarketDateText(record.tradeDate) ??
    extractMarketDateText(record.date);
  if (direct) {
    return direct;
  }
  return (
    extractOverrideMarketDate(record.time_window) ??
    extractOverrideMarketDate(record.timeWindow) ??
    extractOverrideMarketDate(record.resolved_window) ??
    extractOverrideMarketDate(record.resolvedWindow)
  );
}

export function resolveSubmissionMarketDate(params: {
  idempotencyKey?: unknown;
  overrides?: unknown;
}) {
  return (
    extractIdempotencyMarketDate(params.idempotencyKey) ??
    extractOverrideMarketDate(params.overrides)
  );
}

function extractCronIdempotencyParts(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const match = /(?:^|:)(cron-([a-z0-9-]+)-(\d{4}-\d{2}-\d{2}))$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return {
    full: match[1]!,
    alias: match[2]!,
    marketDate: match[3]! as MarketDateText,
  };
}

function resolveCronStrategyAlias(params: { taskKey?: string; idempotencyKey?: string }) {
  const mapped = params.taskKey ? CRON_TASK_ALIASES[params.taskKey] : undefined;
  if (mapped) {
    return mapped;
  }
  return extractCronIdempotencyParts(params.idempotencyKey)?.alias;
}

function buildCronIdempotencyKey(alias: string, marketDate: MarketDateText) {
  return `cron-${alias}-${marketDate}`;
}

function normalizeCronTraceId(value: string, marketDate: MarketDateText) {
  return /:\d{4}-\d{2}-\d{2}$/.test(value)
    ? value.replace(/:\d{4}-\d{2}-\d{2}$/, `:${marketDate}`)
    : value;
}

function replaceCronRequestKeyDate(params: {
  requestKey?: string;
  oldIdempotencyKey: string;
  newIdempotencyKey: string;
}) {
  if (!params.requestKey?.trim()) {
    return params.newIdempotencyKey;
  }
  const requestKey = params.requestKey.trim();
  if (requestKey === params.oldIdempotencyKey) {
    return params.newIdempotencyKey;
  }
  if (requestKey.endsWith(`:${params.oldIdempotencyKey}`)) {
    return `${requestKey.slice(0, -params.oldIdempotencyKey.length)}${params.newIdempotencyKey}`;
  }
  return requestKey;
}

export function normalizeCronStrategyTaskRunParams(
  params: Record<string, unknown>,
  marketDate: MarketDateText,
) {
  const submission = validateStrategyTaskRunSubmission(params);
  if (submission.triggerType !== "cron") {
    return { params, submission, changed: false };
  }
  const alias = resolveCronStrategyAlias({
    taskKey: submission.taskKey,
    idempotencyKey: submission.idempotencyKey,
  });
  if (!alias) {
    throw new Error("strategy_task_run cron submissions require a strategy alias");
  }
  const idempotencyKey = buildCronIdempotencyKey(alias, marketDate);
  const traceId = normalizeCronTraceId(submission.traceId, marketDate);
  const normalizedParams = {
    ...params,
    idempotency_key: idempotencyKey,
    trace_id: traceId,
  };
  return {
    params: normalizedParams,
    submission: validateStrategyTaskRunSubmission(normalizedParams),
    changed: idempotencyKey !== submission.idempotencyKey || traceId !== submission.traceId,
  };
}

export function normalizeCronStrategyWatchParams(
  params: Record<string, unknown>,
  marketDate: MarketDateText,
) {
  const triggerType = readString(params, "trigger_type");
  if (triggerType !== "cron") {
    return { params, changed: false };
  }
  const idempotencyKey = readString(params, "idempotency_key") ?? readString(params, "request_key");
  if (!idempotencyKey) {
    return { params, changed: false };
  }
  const idempotency = extractCronIdempotencyParts(idempotencyKey);
  if (!idempotency) {
    throw new Error(
      "strategy_watch_run cron submissions require idempotency_key=cron-{strategy-alias}-{yyyy-mm-dd}",
    );
  }
  const alias = resolveCronStrategyAlias({
    taskKey: readString(params, "task_key"),
    idempotencyKey,
  });
  if (!alias) {
    throw new Error("strategy_watch_run cron submissions require a strategy alias");
  }
  const normalizedIdempotencyKey = buildCronIdempotencyKey(alias, marketDate);
  const traceId = readString(params, "trace_id");
  const requestKey = replaceCronRequestKeyDate({
    requestKey: readString(params, "request_key"),
    oldIdempotencyKey: idempotency.full,
    newIdempotencyKey: normalizedIdempotencyKey,
  });
  const normalizedParams = {
    ...params,
    idempotency_key: normalizedIdempotencyKey,
    request_key: requestKey,
    ...(traceId ? { trace_id: normalizeCronTraceId(traceId, marketDate) } : {}),
  };
  return {
    params: normalizedParams,
    changed:
      normalizedIdempotencyKey !== idempotency.full ||
      requestKey !== readString(params, "request_key") ||
      normalizedParams.trace_id !== params.trace_id,
  };
}

function assertIdempotencyShape(triggerType: StrategyTriggerType, idempotencyKey: string) {
  if (triggerType === "cron" && !/^cron-[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/.test(idempotencyKey)) {
    throw new Error(
      "strategy_task_run cron submissions require idempotency_key=cron-{strategy-alias}-{yyyy-mm-dd}",
    );
  }
  if (
    triggerType === "gateway_recovery" &&
    !/^recovery-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d+$/.test(idempotencyKey)
  ) {
    throw new Error(
      "strategy_task_run gateway_recovery submissions require idempotency_key=recovery-{strategy-alias}-{yyyy-mm-dd}-{attempt}",
    );
  }
}

export function validateStrategyTaskRunSubmission(
  params: Record<string, unknown>,
): StrategyTaskRunSubmission {
  const taskKey = readRequiredString(params, "task_key");
  const idempotencyKey = readRequiredString(params, "idempotency_key");
  const source = readRequiredString(params, "source");
  const requestedBy = readRequiredString(params, "requested_by");
  const traceId = readRequiredString(params, "trace_id");
  const triggerTypeRaw = readRequiredString(params, "trigger_type");
  if (!STRATEGY_TRIGGER_TYPES.has(triggerTypeRaw)) {
    throw new Error(
      "strategy_task_run trigger_type must be cron, gateway_recovery, manual, or retry",
    );
  }
  const triggerType = triggerTypeRaw as StrategyTriggerType;
  assertIdempotencyShape(triggerType, idempotencyKey);
  return {
    taskKey,
    idempotencyKey,
    source,
    requestedBy,
    traceId,
    triggerType,
    marketDate: resolveSubmissionMarketDate({
      idempotencyKey,
      overrides: params.overrides,
    }),
  };
}

function watchMatchesSubmissionIdempotency(
  watch: PatternStrategyAsyncWatch,
  submission: StrategyTaskRunSubmission,
) {
  const candidates = [watch.idempotencyKey, watch.requestKey].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return candidates.some(
    (value) =>
      value === submission.idempotencyKey || value.endsWith(`:${submission.idempotencyKey}`),
  );
}

export function findActiveStrategyWatch(params: {
  watches: PatternStrategyAsyncWatch[];
  submission: StrategyTaskRunSubmission;
}) {
  return params.watches.find((watch) => {
    if (watch.completedAt || watch.taskKey !== params.submission.taskKey) {
      return false;
    }
    if (isStrategyTerminalStatus(watch.lastRemoteStatus)) {
      return false;
    }
    // Active-watch dedupe is scoped by idempotency first, then market date.
    // Cron, manual, and retry runs for the same date must not hijack each other.
    if (!watchMatchesSubmissionIdempotency(watch, params.submission)) {
      return false;
    }
    const watchMarketDate =
      watch.marketDate ??
      resolveSubmissionMarketDate({
        idempotencyKey: watch.idempotencyKey ?? watch.requestKey,
        overrides: watch.resolvedWindow,
      });
    if (!params.submission.marketDate || !watchMarketDate) {
      return true;
    }
    return watchMarketDate === params.submission.marketDate;
  });
}
