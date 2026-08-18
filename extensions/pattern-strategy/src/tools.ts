import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { listAsyncWatches, updateAsyncWatch } from "./async-watch-store.js";
import {
  formatPatternStrategyResult,
  invokePatternStrategyTool,
  type PatternStrategyPluginConfig,
} from "./client.js";
import { createPatternStrategyLocalTools } from "./local-tools.js";
import {
  resolveLatestAvailableTradeDate,
  type LatestAvailableTradeDate,
} from "./market-calendar.js";
import { extractMarketDateText } from "./model-boundary-harness.js";
import {
  findActiveStrategyWatch,
  isStrategyTerminalStatus,
  normalizeStrategyStatus,
  normalizeCronStrategyTaskRunParams,
  validateStrategyTaskRunSubmission,
  type StrategyTaskRunSubmission,
} from "./strategy-submission.js";

type ToolDef = {
  name: string;
  label: string;
  description: string;
  remoteToolName: string;
  parameters: Record<string, unknown>;
};

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
const stringArraySchema = () => ({ type: "array", items: { type: "string" } });
const stringEnumSchema = (values: string[]) => ({ type: "string", enum: values });

function resolveStateDir(api: OpenClawPluginApi) {
  try {
    return api.runtime.state.resolveStateDir(process.env);
  } catch {
    return undefined;
  }
}

function buildMcpLogContext(submission: StrategyTaskRunSubmission) {
  return {
    taskKey: submission.taskKey,
    idempotencyKey: submission.idempotencyKey,
    source: submission.source,
    requestedBy: submission.requestedBy,
    traceId: submission.traceId,
    triggerType: submission.triggerType,
  };
}

type RemotePayload = Awaited<ReturnType<typeof invokePatternStrategyTool>>;

function dataRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withSubmissionData(params: {
  payload: RemotePayload;
  submission: StrategyTaskRunSubmission;
  latestTradeDate?: LatestAvailableTradeDate;
}) {
  const data = dataRecord(params.payload.data);
  const requestKey = readRequiredString(data, "request_key");
  const expectedPrefix = `${params.submission.taskKey}:`;
  if (!requestKey.startsWith(expectedPrefix)) {
    throw new Error("strategy.task_run returned a request_key for a different task");
  }
  const requestIdempotencyKey = requestKey.slice(expectedPrefix.length).trim();
  const responseIdempotencyKey =
    typeof data.idempotency_key === "string" && data.idempotency_key.trim()
      ? data.idempotency_key.trim()
      : requestIdempotencyKey;
  if (!requestIdempotencyKey || requestKey !== `${expectedPrefix}${responseIdempotencyKey}`) {
    throw new Error("strategy.task_run returned inconsistent canonical idempotency metadata");
  }
  const resolvedWindow = dataRecord(data.resolved_window);
  const marketDate = extractMarketDateText(resolvedWindow.end_date);
  if (!marketDate) {
    throw new Error("strategy.task_run returned no canonical resolved_window.end_date");
  }
  if (
    params.submission.triggerType === "cron" &&
    extractMarketDateText(responseIdempotencyKey) !== marketDate
  ) {
    throw new Error("strategy.task_run canonical request_key does not match resolved_window");
  }
  return {
    ...params.payload,
    data: {
      ...data,
      task_key: params.submission.taskKey,
      idempotency_key: responseIdempotencyKey,
      source: params.submission.source,
      requested_by: params.submission.requestedBy,
      trace_id: params.submission.traceId,
      trigger_type: params.submission.triggerType,
      market_date: marketDate,
      latest_trade_date_source: params.latestTradeDate?.source,
    },
  };
}

function readRequiredString(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} required`);
  }
  return value.trim();
}

function isCronContext(ctx: OpenClawPluginToolContext) {
  return /(?:^|:)cron:/.test(ctx.sessionKey?.trim() ?? "");
}

function normalizeCronIndiceRefreshParams(params: Record<string, unknown>) {
  return {
    dimensions: params.dimensions,
    ...(typeof params.refresh_turnover === "boolean"
      ? { refresh_turnover: params.refresh_turnover }
      : {}),
    ...(typeof params.force_universe === "boolean"
      ? { force_universe: params.force_universe }
      : {}),
    source: "openclaw_cron",
  };
}

function assertCanonicalCronIndiceResponse(payload: RemotePayload) {
  if (payload.ok === false) {
    return payload;
  }
  const data = dataRecord(payload.data);
  for (const key of ["job_id", "start_date", "end_date", "idempotency_key"] as const) {
    readRequiredString(data, key);
  }
  if (readRequiredString(data, "source") !== "openclaw_cron") {
    throw new Error("indice.refresh_run returned a non-cron canonical source");
  }
  return payload;
}

function inferCronJobId(ctx: OpenClawPluginToolContext) {
  return /(?:^|:)cron:([^:]+)(?::|$)/.exec(ctx.sessionKey?.trim() ?? "")?.[1];
}

function enforceManualCancel(params: Record<string, unknown>) {
  const triggerType = readRequiredString(params, "trigger_type");
  if (triggerType !== "manual" || params.manual_confirmed !== true) {
    throw new Error(
      "strategy_cancel_run is only allowed for explicit manual cancellation with trigger_type=manual and manual_confirmed=true",
    );
  }
  return { job_id: readRequiredString(params, "job_id") };
}

async function findGatewayActiveWatch(params: {
  api: OpenClawPluginApi;
  submission: StrategyTaskRunSubmission;
}) {
  const stateDir = resolveStateDir(params.api);
  if (!stateDir) {
    return undefined;
  }
  const watches = await listAsyncWatches(stateDir);
  return findActiveStrategyWatch({ watches, submission: params.submission });
}

async function assertRunSucceededBeforeSignalFetch(params: {
  api: OpenClawPluginApi;
  toolParams: Record<string, unknown>;
  pluginConfig?: PatternStrategyPluginConfig;
}) {
  const jobId = readRequiredString(params.toolParams, "job_id");
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "strategy.get_run",
    args: { job_id: jobId },
    logger: params.api.logger,
  });
  const result = await formatPatternStrategyResult({
    remoteToolName: "strategy.get_run",
    payload,
    pluginConfig: params.pluginConfig,
  });
  const runData = dataRecord(result.details?.data);
  const status = normalizeStrategyStatus(runData.status);
  if (status !== "succeeded") {
    throw new Error(`strategy_get_signals requires status=succeeded; job_id ${jobId} is ${status}`);
  }
}

function createRemoteTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext, def: ToolDef) {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      let submission: StrategyTaskRunSubmission | undefined;
      let latestTradeDate: LatestAvailableTradeDate | undefined;
      let remoteParams = params;
      const pluginConfig = api.pluginConfig as PatternStrategyPluginConfig | undefined;
      const cronIndiceSubmission =
        def.remoteToolName === "indice.refresh_run" && isCronContext(ctx);
      if (def.remoteToolName === "strategy.task_run") {
        const cronSubmission = isCronContext(ctx) || params.trigger_type === "cron";
        if (cronSubmission) {
          latestTradeDate = await resolveLatestAvailableTradeDate({
            pluginConfig,
            logger: api.logger,
          });
          const normalized = normalizeCronStrategyTaskRunParams(params, latestTradeDate.tradeDate, {
            cronJobId: inferCronJobId(ctx),
          });
          submission = normalized.submission;
          remoteParams = normalized.params;
        } else {
          submission = validateStrategyTaskRunSubmission(params);
        }
      } else if (cronIndiceSubmission) {
        remoteParams = normalizeCronIndiceRefreshParams(params);
      }
      if (submission) {
        const activeWatch = await findGatewayActiveWatch({ api, submission });
        if (activeWatch) {
          const activePayload = await invokePatternStrategyTool({
            pluginConfig,
            toolName: "strategy.get_run",
            args: { job_id: activeWatch.jobId },
            logger: api.logger,
            logContext: buildMcpLogContext(submission),
          });
          const activeData =
            activePayload.data && typeof activePayload.data === "object"
              ? (activePayload.data as Record<string, unknown>)
              : {};
          const activeStatus = normalizeStrategyStatus(activeData.status);
          if (isStrategyTerminalStatus(activeStatus)) {
            const stateDir = resolveStateDir(api);
            if (stateDir) {
              const now = Date.now();
              await updateAsyncWatch(stateDir, activeWatch.jobId, (existing) => ({
                ...existing,
                lastRemoteStatus: activeStatus,
                updatedAt: now,
                completedAt: existing.completedAt ?? now,
              }));
            }
          } else {
            return await formatPatternStrategyResult({
              remoteToolName: def.remoteToolName,
              payload: {
                ...activePayload,
                tool_name: def.remoteToolName,
                data: {
                  ...activeData,
                  job_id: activeWatch.jobId,
                  task_key: submission.taskKey,
                  idempotency_key: submission.idempotencyKey,
                  source: submission.source,
                  requested_by: submission.requestedBy,
                  trace_id: submission.traceId,
                  trigger_type: submission.triggerType,
                  gateway_deduped: true,
                  gateway_deduped_by_job_id: activeWatch.jobId,
                },
              },
              pluginConfig,
            });
          }
        }
      }
      const args =
        def.remoteToolName === "strategy.cancel_run" ? enforceManualCancel(params) : remoteParams;
      if (def.remoteToolName === "strategy.get_signals") {
        await assertRunSucceededBeforeSignalFetch({
          api,
          toolParams: args,
          pluginConfig,
        });
      }
      const payload = await invokePatternStrategyTool({
        pluginConfig,
        toolName: def.remoteToolName,
        args,
        logger: api.logger,
        logContext: submission ? buildMcpLogContext(submission) : undefined,
      });
      const resultPayload =
        submission && def.remoteToolName === "strategy.task_run"
          ? withSubmissionData({ payload, submission, latestTradeDate })
          : cronIndiceSubmission
            ? assertCanonicalCronIndiceResponse(payload)
            : payload;
      return await formatPatternStrategyResult({
        remoteToolName: def.remoteToolName,
        payload: resultPayload,
        pluginConfig,
      });
    },
  };
}

const toolDefs: ToolDef[] = [
  {
    name: "strategy_task_list",
    label: "Strategy Task List",
    description:
      "List registered Pattern Strategy task templates. Bridges remote tool `strategy.task_list`.",
    remoteToolName: "strategy.task_list",
    parameters: objectSchema({}),
  },
  {
    name: "strategy_task_describe",
    label: "Strategy Task Describe",
    description:
      "Describe a Pattern Strategy task template. Bridges remote tool `strategy.task_describe`.",
    remoteToolName: "strategy.task_describe",
    parameters: objectSchema({ task_key: stringSchema() }, ["task_key"]),
  },
  {
    name: "strategy_task_run",
    label: "Strategy Task Run",
    description:
      "Submit a Pattern Strategy task run through the shared backend queue and return the authoritative `job_id` for user-visible processing status. Cron sessions only need task_key and overrides; the bridge forwards cron business intent, while the backend-returned request_key, idempotency_key, and resolved_window are authoritative. Non-cron calls must provide trigger_type and the required submission metadata; use manual for fresh Feishu user requests, not manual_retry. Bridges remote tool `strategy.task_run`.",
    remoteToolName: "strategy.task_run",
    parameters: objectSchema(
      {
        task_key: stringSchema(),
        idempotency_key: stringSchema(),
        overrides: unknownSchema(),
        source: stringSchema(),
        requested_by: stringSchema(),
        trace_id: stringSchema(),
        trigger_type: stringSchema(),
        run_label: stringSchema(),
      },
      ["task_key"],
    ),
  },
  {
    name: "strategy_get_run",
    label: "Strategy Get Run",
    description: "Get a Pattern Strategy run status. Bridges remote tool `strategy.get_run`.",
    remoteToolName: "strategy.get_run",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
  },
  {
    name: "strategy_cancel_run",
    label: "Strategy Cancel Run",
    description:
      "Cancel a running Pattern Strategy job. Bridges remote tool `strategy.cancel_run`.",
    remoteToolName: "strategy.cancel_run",
    parameters: objectSchema(
      {
        job_id: stringSchema(),
        trigger_type: stringSchema(),
        manual_confirmed: booleanSchema(),
      },
      ["job_id", "trigger_type", "manual_confirmed"],
    ),
  },
  {
    name: "strategy_get_signals",
    label: "Strategy Get Signals",
    description:
      "Fetch signals produced by a Pattern Strategy run. Bridges remote tool `strategy.get_signals`.",
    remoteToolName: "strategy.get_signals",
    parameters: objectSchema(
      {
        job_id: stringSchema(),
        limit: numberSchema(),
        order: stringSchema(),
      },
      ["job_id"],
    ),
  },
  {
    name: "market_latest_available_trade_date",
    label: "Market Latest Available Trade Date",
    description:
      "Resolve the latest Pattern market trade date available for daily scans. Bridges remote tool `market.latest_available_trade_date`.",
    remoteToolName: "market.latest_available_trade_date",
    parameters: objectSchema(
      {
        market: stringEnumSchema(["CN_A"]),
        as_of: stringSchema(),
        purpose: stringEnumSchema(["daily_scan"]),
      },
      ["market", "as_of", "purpose"],
    ),
  },
  {
    name: "market_trade_calendar",
    label: "Market Trade Calendar",
    description:
      "Query Pattern market trade-calendar rows. Bridges remote tool `market.trade_calendar`.",
    remoteToolName: "market.trade_calendar",
    parameters: objectSchema({
      start_date: stringSchema(),
      end_date: stringSchema(),
      reference_date: stringSchema(),
      include_closed: booleanSchema(),
      limit: numberSchema(),
      order: stringEnumSchema(["asc", "desc"]),
    }),
  },
  {
    name: "market_list_price_cache",
    label: "Market List Price Cache",
    description: "List local market cache metadata. Bridges remote tool `market.list_price_cache`.",
    remoteToolName: "market.list_price_cache",
    parameters: objectSchema({}),
  },
  {
    name: "market_get_bars",
    label: "Market Get Bars",
    description: "Fetch recent OHLC bars. Bridges remote tool `market.get_bars`.",
    remoteToolName: "market.get_bars",
    parameters: objectSchema(
      {
        symbol: stringSchema(),
        adjustment: stringSchema(),
        window: numberSchema(),
        compare_live: booleanSchema(),
      },
      ["symbol"],
    ),
  },
  {
    name: "chan_generate_chart",
    label: "Chan Generate Chart",
    description:
      "Generate a Chan theory chart for a stock, ETF, or security over a date window. Bridges remote tool `chan.generate_chart`.",
    remoteToolName: "chan.generate_chart",
    parameters: objectSchema(
      {
        symbol: stringSchema(),
        security_name: stringSchema(),
        start_date: stringSchema(),
        end_date: stringSchema(),
        use_price_cache: booleanSchema(),
        merge_threshold: numberSchema(),
      },
      ["start_date", "end_date"],
    ),
  },
  {
    name: "factor_margin_balance_change",
    label: "Factor Margin Balance Change",
    description:
      "Fetch financing balance changes for signaled securities. Bridges remote tool `factor.margin_balance_change`.",
    remoteToolName: "factor.margin_balance_change",
    parameters: objectSchema(
      {
        symbols: stringArraySchema(),
        end_trade_date: stringSchema(),
        start_trade_date: stringSchema(),
        lookback_trade_days: numberSchema(),
        include_series: booleanSchema(),
      },
      ["symbols"],
    ),
  },
  {
    name: "factor_financial_growth",
    label: "Factor Financial Growth",
    description:
      "Fetch quarterly revenue, profit, EPS, ROE growth and acceleration context. Bridges remote tool `factor.financial_growth`.",
    remoteToolName: "factor.financial_growth",
    parameters: objectSchema(
      {
        symbols: stringArraySchema(),
        end_report: stringSchema(),
        lookback_quarters: numberSchema(),
        include_series: booleanSchema(),
        as_of_date: stringSchema(),
        strict_point_in_time: booleanSchema(),
      },
      ["symbols"],
    ),
  },
  {
    name: "factor_institution_holder_change",
    label: "Factor Institution Holder Change",
    description:
      "Fetch quarter-over-quarter changes in focused institutional holders among top ten float holders. Bridges remote tool `factor.institution_holder_change`.",
    remoteToolName: "factor.institution_holder_change",
    parameters: objectSchema(
      {
        symbols: stringArraySchema(),
        end_report: stringSchema(),
        lookback_quarters: numberSchema(),
        include_holders: booleanSchema(),
      },
      ["symbols"],
    ),
  },
  {
    name: "indice_refresh_run",
    label: "Indice Refresh Run",
    description:
      "Start a Pattern board-index refresh job for industry, size, style, and concept indices. In cron sessions, pass dimensions/options only: the bridge forces source=openclaw_cron and the Pattern backend owns dates and idempotency. Bridges remote tool `indice.refresh_run`.",
    remoteToolName: "indice.refresh_run",
    parameters: objectSchema(
      {
        start_date: stringSchema(),
        end_date: stringSchema(),
        dimensions: stringArraySchema(),
        refresh_turnover: booleanSchema(),
        force_universe: booleanSchema(),
        source: stringSchema(),
        idempotency_key: stringSchema(),
      },
      ["dimensions"],
    ),
  },
  {
    name: "indice_refresh_get",
    label: "Indice Refresh Get",
    description:
      "Get a Pattern board-index refresh job status. Omit job_id to read the latest refresh job. Bridges remote tool `indice.refresh_get`.",
    remoteToolName: "indice.refresh_get",
    parameters: objectSchema({ job_id: stringSchema() }),
  },
  {
    name: "indice_refresh_errors",
    label: "Indice Refresh Errors",
    description:
      "List per-index failures for a Pattern board-index refresh job. Bridges remote tool `indice.refresh_errors`.",
    remoteToolName: "indice.refresh_errors",
    parameters: objectSchema({ job_id: stringSchema(), limit: numberSchema() }, ["job_id"]),
  },
];

export function createPatternStrategyTools(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  return [
    ...toolDefs.map((def) => createRemoteTool(api, ctx, def)),
    ...createPatternStrategyLocalTools(api, ctx),
  ];
}
