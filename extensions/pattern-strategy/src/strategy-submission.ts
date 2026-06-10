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
