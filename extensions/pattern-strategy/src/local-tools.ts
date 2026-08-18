import { loadSessionStore, resolveStorePath } from "../../../src/config/sessions.js";
import { appendAgentInteractionAuditRecord } from "../../../src/infra/agent-interaction-audit.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatSummaryForAgent,
} from "../../../src/infra/heartbeat-runner.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import {
  schedulePatternIndiceWatchNow,
  schedulePatternStrategyWatchNow,
} from "./async-watch-service.js";
import {
  getAsyncWatch,
  listAsyncWatches,
  removeAsyncWatch,
  type AsyncCompletionWakeMode,
  type PatternStrategyAsyncWatch,
  upsertAsyncWatch,
} from "./async-watch-store.js";
import {
  getLatestAutomationRun,
  listAutomationRuns,
  recordAutomationRun,
  type AutomationRunRecord,
  type AutomationRunFilter,
} from "./automation-run-store.js";
import {
  getIndiceAsyncWatch,
  listIndiceAsyncWatches,
  removeIndiceAsyncWatch,
  type IndiceRefreshAsyncWatch,
  upsertIndiceAsyncWatch,
} from "./indice-watch-store.js";
import { extractMarketDateText, MARKET_TIMEZONE } from "./model-boundary-harness.js";
import { resolveSubmissionMarketDate } from "./strategy-submission.js";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const stringSchema = () => ({ type: "string" });
const numberSchema = () => ({ type: "number" });
const booleanSchema = () => ({ type: "boolean" });
const unknownSchema = () => ({});
const stringEnumSchema = (values: string[]) => ({ type: "string", enum: values });

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type LocalToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    ctx: OpenClawPluginToolContext,
    params: Record<string, unknown>,
    api: OpenClawPluginApi,
  ) => Promise<ToolResult>;
};

type CompletionDeliverySnapshot = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalThreadId(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactDeliverySnapshot(
  snapshot: CompletionDeliverySnapshot,
): CompletionDeliverySnapshot | undefined {
  const compacted: CompletionDeliverySnapshot = {
    ...(snapshot.channel ? { channel: snapshot.channel } : {}),
    ...(snapshot.to ? { to: snapshot.to } : {}),
    ...(snapshot.accountId ? { accountId: snapshot.accountId } : {}),
    ...(snapshot.threadId !== undefined ? { threadId: snapshot.threadId } : {}),
  };
  return compacted.channel ||
    compacted.to ||
    compacted.accountId ||
    compacted.threadId !== undefined
    ? compacted
    : undefined;
}

function resolveContextDeliverySnapshot(
  ctx: OpenClawPluginToolContext,
): CompletionDeliverySnapshot | undefined {
  return compactDeliverySnapshot({
    channel:
      readOptionalString(ctx.deliveryContext?.channel) ?? readOptionalString(ctx.messageChannel),
    to: readOptionalString(ctx.deliveryContext?.to),
    accountId:
      readOptionalString(ctx.deliveryContext?.accountId) ?? readOptionalString(ctx.agentAccountId),
    threadId: readOptionalThreadId(ctx.deliveryContext?.threadId),
  });
}

function resolveSessionDeliverySnapshot(params: {
  ctx: OpenClawPluginToolContext;
  sessionKey?: string;
  agentId?: string;
}): CompletionDeliverySnapshot | undefined {
  const sessionKey = params.sessionKey?.trim() || params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = params.agentId?.trim() || params.ctx.agentId?.trim();
  const storePath = resolveStorePath(params.ctx.config?.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath) as Record<string, unknown>;
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
    if (!isRecord(entry)) {
      return undefined;
    }
    const deliveryContext = isRecord(entry.deliveryContext) ? entry.deliveryContext : {};
    return compactDeliverySnapshot({
      channel: readOptionalString(deliveryContext.channel) ?? readOptionalString(entry.lastChannel),
      to: readOptionalString(deliveryContext.to) ?? readOptionalString(entry.lastTo),
      accountId:
        readOptionalString(deliveryContext.accountId) ?? readOptionalString(entry.lastAccountId),
      threadId:
        readOptionalThreadId(deliveryContext.threadId) ?? readOptionalThreadId(entry.lastThreadId),
    });
  } catch {
    return undefined;
  }
}

function resolveCompletionDeliverySnapshot(params: {
  ctx: OpenClawPluginToolContext;
  sessionKey?: string;
  agentId?: string;
}) {
  return (
    resolveContextDeliverySnapshot(params.ctx) ??
    resolveSessionDeliverySnapshot({
      ctx: params.ctx,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    })
  );
}

function resolveWatchSessionKey(params: {
  ctx: OpenClawPluginToolContext;
  explicitSessionKey?: unknown;
}) {
  const explicit =
    typeof params.explicitSessionKey === "string" ? params.explicitSessionKey.trim() : "";
  if (explicit.startsWith("agent:")) {
    return explicit;
  }
  return params.ctx.sessionKey?.trim();
}

function shouldForceEnrichment(taskKey?: string) {
  return (
    taskKey === "strategy.mid_term_accel.daily_scan" ||
    taskKey === "strategy.mid_term_reversal_opt.daily_scan" ||
    taskKey === "strategy.strong_pivot_breakout.daily_scan"
  );
}

function resolveWatchMaxSignals(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 20;
}

function formatLocalToolResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function readString(params: Record<string, unknown>, key: string) {
  const value = params[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function readRequiredString(params: Record<string, unknown>, key: string) {
  const value = readString(params, key);
  if (!value) {
    throw new Error(`${key} required`);
  }
  return value;
}

function readNumber(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readSymbols(params: Record<string, unknown>) {
  const value = params.symbols;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

function readAutomationRunFilter(params: Record<string, unknown>): AutomationRunFilter {
  return {
    category: readString(params, "category"),
    taskFamily: readString(params, "task_family"),
    taskKey: readString(params, "task_key"),
    status: readString(params, "status"),
    source: readString(params, "source"),
    limit: readNumber(params, "limit"),
  };
}

function filterRunsByMarketDate(records: AutomationRunRecord[], marketDate: string) {
  return records.filter((record) => extractMarketDateText(record.runTime) === marketDate);
}

function inferCronJobId(ctx: OpenClawPluginToolContext) {
  const sessionKey = ctx.sessionKey?.trim() ?? "";
  const match = /(?:^|:)cron:([^:]+)/.exec(sessionKey);
  return match?.[1];
}

const cronBlockedAutomationReadTools = new Set([
  "automation_run_daily_summary",
  "automation_run_latest",
  "automation_run_list",
]);

const cronOnlyAutomationWriteTools = new Set(["automation_run_record"]);

function isCronExecutionContext(ctx: OpenClawPluginToolContext) {
  return Boolean(ctx.sessionKey?.includes(":cron:"));
}

const localToolDefs: LocalToolDef[] = [
  {
    name: "automation_run_record",
    label: "Automation Run Record",
    description:
      "Cron execution only: record a scheduled business automation run in the Pattern Strategy registry and mirror a compact row to memory/automation-runs.md for Feishu recall.",
    parameters: objectSchema(
      {
        run_time: stringSchema(),
        source: stringSchema(),
        category: stringSchema(),
        task_family: stringSchema(),
        task_key: stringSchema(),
        cron_job_id: stringSchema(),
        business_job_id: stringSchema(),
        status: stringSchema(),
        raw_count: numberSchema(),
        returned_count: numberSchema(),
        symbols: unknownSchema(),
        overrides: unknownSchema(),
        notes: stringSchema(),
        memory_path: stringSchema(),
      },
      ["category", "task_family", "task_key", "status"],
    ),
    async execute(ctx, params, api) {
      const memoryPath = readString(params, "memory_path") ?? "memory/automation-runs.md";
      const record = await recordAutomationRun({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        workspaceDir: ctx.workspaceDir,
        memoryRelPath: memoryPath,
        record: {
          runTime: readString(params, "run_time"),
          source: readString(params, "source"),
          category: readRequiredString(params, "category"),
          taskFamily: readRequiredString(params, "task_family"),
          taskKey: readRequiredString(params, "task_key"),
          cronJobId: readString(params, "cron_job_id") ?? inferCronJobId(ctx),
          businessJobId: readString(params, "business_job_id"),
          status: readRequiredString(params, "status"),
          rawCount: readNumber(params, "raw_count"),
          returnedCount: readNumber(params, "returned_count"),
          symbols: readSymbols(params),
          overrides: params.overrides,
          notes: readString(params, "notes"),
        },
      });
      return formatLocalToolResult({
        ok: true,
        record,
        memory_path: ctx.workspaceDir ? memoryPath : null,
      });
    },
  },
  {
    name: "automation_run_latest",
    label: "Automation Run Latest",
    description:
      "Human lookup only: return the latest recorded automation run, optionally filtered by category, task_family, task_key, status, or source. Not exposed to cron execution sessions.",
    parameters: objectSchema({
      category: stringSchema(),
      task_family: stringSchema(),
      task_key: stringSchema(),
      status: stringSchema(),
      source: stringSchema(),
    }),
    async execute(_ctx, params, api) {
      const record = await getLatestAutomationRun({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        filter: readAutomationRunFilter(params),
      });
      return formatLocalToolResult({
        ok: true,
        record,
      });
    },
  },
  {
    name: "automation_run_list",
    label: "Automation Run List",
    description:
      "Human lookup only: list recorded automation runs, optionally filtered by category, task_family, task_key, status, source, and limit. Not exposed to cron execution sessions.",
    parameters: objectSchema({
      category: stringSchema(),
      task_family: stringSchema(),
      task_key: stringSchema(),
      status: stringSchema(),
      source: stringSchema(),
      limit: numberSchema(),
    }),
    async execute(_ctx, params, api) {
      const records = await listAutomationRuns({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        filter: readAutomationRunFilter(params),
      });
      return formatLocalToolResult({
        ok: true,
        records,
      });
    },
  },
  {
    name: "automation_run_daily_summary",
    label: "Automation Run Daily Summary",
    description:
      "Human lookup only: return recorded automation runs for one China A-share market date. Use this first for Feishu questions about today's cron or scheduled strategy execution. Not exposed to cron execution sessions.",
    parameters: objectSchema({
      market_date: stringSchema(),
      category: stringSchema(),
      task_family: stringSchema(),
      task_key: stringSchema(),
      source: stringSchema(),
      limit: numberSchema(),
    }),
    async execute(_ctx, params, api) {
      const marketDate = readString(params, "market_date") ?? extractMarketDateText(new Date());
      if (!marketDate) {
        throw new Error("market_date required");
      }
      const records = await listAutomationRuns({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        filter: readAutomationRunFilter({ ...params, limit: readNumber(params, "limit") ?? 50 }),
      });
      const matching = filterRunsByMarketDate(records, marketDate);
      const families = Array.from(new Set(matching.map((record) => record.taskFamily)));
      const latestByFamily = families.map((family) => {
        const [latest] = matching.filter((record) => record.taskFamily === family);
        return latest;
      });
      return formatLocalToolResult({
        ok: true,
        market_timezone: MARKET_TIMEZONE,
        market_date: marketDate,
        count: matching.length,
        latest_by_family: latestByFamily,
        records: matching,
      });
    },
  },
  {
    name: "indice_watch_refresh",
    label: "Indice Watch Refresh",
    description:
      "[Board index refresh] Register an async watcher for a Pattern board-index refresh job. On terminal status it delivers a deterministic Feishu/chat update without waking the LLM.",
    parameters: objectSchema(
      {
        job_id: stringSchema(),
        source: stringSchema(),
        request_key: stringSchema(),
        run_label: stringSchema(),
        session_key: stringSchema(),
        agent_id: stringSchema(),
        wake_mode: stringEnumSchema(["now", "next-heartbeat"]),
        start_date: stringSchema(),
        refresh_date: stringSchema(),
      },
      ["job_id"],
    ),
    async execute(ctx, params, api) {
      const jobId = readRequiredString(params, "job_id");
      const sessionKey = resolveWatchSessionKey({
        ctx,
        explicitSessionKey: params.session_key,
      });
      if (!sessionKey) {
        throw new Error(
          "indice_watch_refresh requires session_key when no current session is available",
        );
      }
      const agentId = readString(params, "agent_id") ?? ctx.agentId?.trim();
      if (!agentId) {
        throw new Error(
          "indice_watch_refresh requires agent_id when no current agent is available",
        );
      }
      const wakeMode =
        readString(params, "wake_mode") === "next-heartbeat"
          ? ("next-heartbeat" as AsyncCompletionWakeMode)
          : ("now" as AsyncCompletionWakeMode);
      const source = readString(params, "source");
      const requestKey = readString(params, "request_key");
      const startDate = extractMarketDateText(params.start_date);
      const refreshDate = extractMarketDateText(params.refresh_date);
      const cronWatch = source === "openclaw_cron" || /(?:^|:)cron:/.test(sessionKey);
      if (cronWatch && (!requestKey || !startDate || !refreshDate)) {
        throw new Error(
          "indice_watch_refresh requires backend-returned start_date, refresh_date, and request_key for cron jobs",
        );
      }
      if (cronWatch && requestKey !== `indice-daily-${refreshDate?.replaceAll("-", "")}`) {
        throw new Error("indice_watch_refresh request_key does not match refresh_date");
      }
      const now = Date.now();
      const watch: IndiceRefreshAsyncWatch = {
        kind: "indice_refresh",
        jobId,
        sessionKey,
        agentId,
        wakeMode,
        source,
        requestKey,
        runLabel: readString(params, "run_label"),
        startDate,
        refreshDate,
        registeredAt: now,
        updatedAt: now,
      };
      const deliverySnapshot = resolveCompletionDeliverySnapshot({ ctx, sessionKey, agentId });
      if (deliverySnapshot) {
        watch.deliverySnapshot = deliverySnapshot;
      }
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      await upsertIndiceAsyncWatch({ stateDir, watch });
      await appendAgentInteractionAuditRecord({
        kind: "async_watch_registered",
        requesterSessionKey: ctx.sessionKey,
        sessionKey: watch.sessionKey,
        agentId: watch.agentId,
        jobId: watch.jobId,
        status: "registered",
        summary: "registered pattern-strategy indice async watch",
        data: {
          source: watch.source,
          requestKey: watch.requestKey,
          runLabel: watch.runLabel,
          wakeMode: watch.wakeMode,
          startDate: watch.startDate,
          refreshDate: watch.refreshDate,
          deliverySnapshot: watch.deliverySnapshot ?? null,
        },
      });
      schedulePatternIndiceWatchNow({ api, stateDir, watch });
      return formatLocalToolResult({
        ok: true,
        service: "Pattern board-index refresh",
        watch: {
          job_id: watch.jobId,
          source: watch.source,
          session_key: watch.sessionKey,
          agent_id: watch.agentId,
          wake_mode: watch.wakeMode,
          start_date: watch.startDate,
          refresh_date: watch.refreshDate,
          heartbeat_enabled: isHeartbeatEnabledForAgent(api.config, watch.agentId),
          heartbeat_summary: resolveHeartbeatSummaryForAgent(api.config, watch.agentId),
          delivery_snapshot: watch.deliverySnapshot ?? null,
        },
      });
    },
  },
  {
    name: "indice_get_watch",
    label: "Indice Get Watch",
    description: "[Board index refresh] Get the registered async watcher state for a job.",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
    async execute(_ctx, params, api) {
      const jobId = readRequiredString(params, "job_id");
      const watch = await getIndiceAsyncWatch({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        jobId,
      });
      return formatLocalToolResult({
        ok: true,
        service: "Pattern board-index refresh",
        watch,
      });
    },
  },
  {
    name: "indice_unwatch_refresh",
    label: "Indice Unwatch Refresh",
    description: "[Board index refresh] Remove a registered async watcher for a job.",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
    async execute(ctx, params, api) {
      const jobId = readRequiredString(params, "job_id");
      const removed = await removeIndiceAsyncWatch({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        jobId,
      });
      await appendAgentInteractionAuditRecord({
        kind: "async_watch_completed",
        requesterSessionKey: ctx.sessionKey,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        jobId,
        status: removed ? "removed" : "missing",
        summary: "removed pattern-strategy indice async watch registration",
      });
      return formatLocalToolResult({
        ok: true,
        service: "Pattern board-index refresh",
        removed,
        job_id: jobId,
      });
    },
  },
  {
    name: "indice_list_watches",
    label: "Indice List Watches",
    description: "[Board index refresh] List registered async board-index refresh watchers.",
    parameters: objectSchema({}),
    async execute(_ctx, _params, api) {
      const watches = await listIndiceAsyncWatches(api.runtime.state.resolveStateDir(process.env));
      return formatLocalToolResult({
        ok: true,
        service: "Pattern board-index refresh",
        watches,
      });
    },
  },
  {
    name: "strategy_watch_run",
    label: "Strategy Watch Run",
    description:
      "Register an async watcher for a Pattern Strategy job. The watcher handles polling in code and only wakes the LLM for actionable final signals.",
    parameters: objectSchema(
      {
        job_id: stringSchema(),
        task_key: stringSchema(),
        request_key: stringSchema(),
        idempotency_key: stringSchema(),
        source: stringSchema(),
        requested_by: stringSchema(),
        trace_id: stringSchema(),
        trigger_type: stringSchema(),
        run_label: stringSchema(),
        session_key: stringSchema(),
        agent_id: stringSchema(),
        wake_mode: stringEnumSchema(["now", "next-heartbeat"]),
        enrich_signals: booleanSchema(),
        max_signals: numberSchema(),
        resolved_window: unknownSchema(),
      },
      ["job_id"],
    ),
    async execute(ctx, params, api) {
      const watchParams = params;
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      if (!jobId) {
        throw new Error("strategy_watch_run requires job_id");
      }
      const sessionKey = resolveWatchSessionKey({
        ctx,
        explicitSessionKey: watchParams.session_key,
      });
      if (!sessionKey) {
        throw new Error(
          "strategy_watch_run requires session_key when no current session is available",
        );
      }
      const agentId =
        typeof watchParams.agent_id === "string" && watchParams.agent_id.trim()
          ? watchParams.agent_id.trim()
          : ctx.agentId?.trim();
      if (!agentId) {
        throw new Error("strategy_watch_run requires agent_id when no current agent is available");
      }
      const wakeMode =
        typeof watchParams.wake_mode === "string" &&
        watchParams.wake_mode.trim() === "next-heartbeat"
          ? ("next-heartbeat" as AsyncCompletionWakeMode)
          : ("now" as AsyncCompletionWakeMode);
      const now = Date.now();
      const taskKey =
        typeof watchParams.task_key === "string" && watchParams.task_key.trim()
          ? watchParams.task_key.trim()
          : undefined;
      const idempotencyKey = readString(watchParams, "idempotency_key");
      const requestKey = readString(watchParams, "request_key");
      const resolvedWindowDate = resolveSubmissionMarketDate({
        overrides: watchParams.resolved_window,
      });
      const idempotencyMarketDate = resolveSubmissionMarketDate({ idempotencyKey });
      const resolvedMarketDate = resolvedWindowDate ?? idempotencyMarketDate;
      const source = readString(watchParams, "source");
      const requestedBy = readString(watchParams, "requested_by");
      const traceId = readString(watchParams, "trace_id");
      const triggerType = readString(watchParams, "trigger_type");
      const cronWatch = triggerType === "cron" || /(?:^|:)cron:/.test(sessionKey);
      if (cronWatch) {
        if (
          !taskKey ||
          !idempotencyKey ||
          !requestKey ||
          !resolvedWindowDate ||
          source !== "openclaw_cron" ||
          !requestedBy ||
          !traceId ||
          triggerType !== "cron"
        ) {
          throw new Error(
            "strategy_watch_run requires the complete backend-returned cron identity and resolved_window",
          );
        }
        if (requestKey !== `${taskKey}:${idempotencyKey}`) {
          throw new Error("strategy_watch_run request_key does not match idempotency_key");
        }
        if (idempotencyMarketDate !== resolvedWindowDate) {
          throw new Error("strategy_watch_run idempotency_key does not match resolved_window");
        }
      }
      const forceEnrichment = shouldForceEnrichment(taskKey);
      const watch: PatternStrategyAsyncWatch = {
        kind: "pattern_strategy_run",
        jobId,
        taskKey,
        idempotencyKey: idempotencyKey ?? requestKey,
        source,
        requestedBy,
        traceId,
        triggerType,
        marketDate: resolvedMarketDate,
        requestKey: requestKey ?? idempotencyKey,
        runLabel:
          typeof watchParams.run_label === "string" && watchParams.run_label.trim()
            ? watchParams.run_label.trim()
            : undefined,
        sessionKey,
        agentId,
        wakeMode,
        followupMode: "direct-agent-delivery",
        enrichSignals: forceEnrichment ? true : watchParams.enrich_signals !== false,
        maxSignals: resolveWatchMaxSignals(watchParams.max_signals),
        resolvedWindow: watchParams.resolved_window,
        registeredAt: now,
        updatedAt: now,
      };
      const deliverySnapshot = resolveCompletionDeliverySnapshot({ ctx, sessionKey, agentId });
      if (deliverySnapshot) {
        watch.deliverySnapshot = deliverySnapshot;
      }
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      await upsertAsyncWatch({ stateDir, watch });
      await appendAgentInteractionAuditRecord({
        kind: "async_watch_registered",
        requesterSessionKey: ctx.sessionKey,
        sessionKey: watch.sessionKey,
        agentId: watch.agentId,
        jobId: watch.jobId,
        status: "registered",
        summary: "registered pattern-strategy async watch",
        data: {
          taskKey: watch.taskKey,
          idempotencyKey: watch.idempotencyKey,
          source: watch.source,
          requestedBy: watch.requestedBy,
          traceId: watch.traceId,
          triggerType: watch.triggerType,
          marketDate: watch.marketDate,
          requestKey: watch.requestKey,
          runLabel: watch.runLabel,
          wakeMode: watch.wakeMode,
          enrichSignals: watch.enrichSignals,
          maxSignals: watch.maxSignals,
          deliverySnapshot: watch.deliverySnapshot ?? null,
        },
      });
      schedulePatternStrategyWatchNow({
        api,
        stateDir,
        ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
        watch,
      });
      return formatLocalToolResult({
        ok: true,
        watch: {
          job_id: watch.jobId,
          task_key: watch.taskKey,
          idempotency_key: watch.idempotencyKey,
          source: watch.source,
          requested_by: watch.requestedBy,
          trace_id: watch.traceId,
          trigger_type: watch.triggerType,
          market_date: watch.marketDate,
          session_key: watch.sessionKey,
          agent_id: watch.agentId,
          wake_mode: watch.wakeMode,
          enrich_signals: watch.enrichSignals,
          max_signals: watch.maxSignals,
          heartbeat_enabled: isHeartbeatEnabledForAgent(api.config, watch.agentId),
          heartbeat_summary: resolveHeartbeatSummaryForAgent(api.config, watch.agentId),
          delivery_snapshot: watch.deliverySnapshot ?? null,
        },
      });
    },
  },
  {
    name: "strategy_get_watch",
    label: "Strategy Get Watch",
    description: "Get the registered async watcher state for a Pattern Strategy job.",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
    async execute(_ctx, params, api) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      if (!jobId) {
        throw new Error("strategy_get_watch requires job_id");
      }
      const watch = await getAsyncWatch({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        jobId,
      });
      return formatLocalToolResult({
        ok: true,
        watch,
      });
    },
  },
  {
    name: "strategy_unwatch_run",
    label: "Strategy Unwatch Run",
    description: "Remove a registered async watcher for a Pattern Strategy job.",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
    async execute(_ctx, params, api) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      if (!jobId) {
        throw new Error("strategy_unwatch_run requires job_id");
      }
      const removed = await removeAsyncWatch({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        jobId,
      });
      await appendAgentInteractionAuditRecord({
        kind: "async_watch_completed",
        requesterSessionKey: _ctx.sessionKey,
        sessionKey: _ctx.sessionKey,
        agentId: _ctx.agentId,
        jobId,
        status: removed ? "removed" : "missing",
        summary: "removed pattern-strategy async watch registration",
      });
      return formatLocalToolResult({
        ok: true,
        removed,
        job_id: jobId,
      });
    },
  },
  {
    name: "strategy_list_watches",
    label: "Strategy List Watches",
    description: "List registered async Pattern Strategy watchers.",
    parameters: objectSchema({}),
    async execute(_ctx, _params, api) {
      const watches = await listAsyncWatches(api.runtime.state.resolveStateDir(process.env));
      return formatLocalToolResult({
        ok: true,
        watches,
      });
    },
  },
];

export function createPatternStrategyLocalTools(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
) {
  const cronExecutionContext = isCronExecutionContext(ctx);
  const visibleDefs = cronExecutionContext
    ? localToolDefs.filter((def) => !cronBlockedAutomationReadTools.has(def.name))
    : localToolDefs.filter((def) => !cronOnlyAutomationWriteTools.has(def.name));
  return visibleDefs.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      return await def.execute(ctx, params, api);
    },
  }));
}
