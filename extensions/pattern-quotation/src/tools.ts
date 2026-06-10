import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { formatPatternQuotationResult, invokePatternQuotationTool } from "./client.js";
import { createPatternQuotationLocalTools } from "./local-tools.js";

type PatternQuotationPluginConfig = {
  baseUrl?: string;
  timeoutMs?: number;
};

type ToolDef = {
  name: string;
  label: string;
  description: string;
  remoteToolName: string;
  parameters: Record<string, unknown>;
  args: (
    params: Record<string, unknown>,
    ctx: OpenClawPluginToolContext,
  ) => Record<string, unknown>;
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const stringSchema = () => ({ type: "string" });
const numberSchema = () => ({ type: "number" });
const arrayOfStringSchema = () => ({ type: "array", items: { type: "string" } });

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function latestCompletedTradingDate(now = new Date()) {
  const shanghaiDate = formatShanghaiDate(now);
  const shanghaiNoon = new Date(`${shanghaiDate}T12:00:00+08:00`);
  const day = shanghaiNoon.getUTCDay();
  const offsetDays = day === 1 ? 3 : day === 0 ? 2 : day === 6 ? 1 : 1;
  return formatShanghaiDate(new Date(shanghaiNoon.getTime() - offsetDays * 24 * 60 * 60 * 1000));
}

function compactDate(date: string) {
  return date.replaceAll("-", "");
}

function readDate(params: Record<string, unknown>, key: string) {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSymbols(params: Record<string, unknown>) {
  const value = params.include_symbols;
  if (Array.isArray(value)) {
    const symbols = value.filter((entry): entry is string => typeof entry === "string");
    return symbols.length > 0 ? symbols.join(",") : "*";
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "*";
}

function readSymbolsArray(params: Record<string, unknown>) {
  const value = params.symbols;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readMaxWorkers(params: Record<string, unknown>) {
  const value = params.max_workers;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return 4;
}

function readAdjust(params: Record<string, unknown>) {
  const value = params.adjust;
  return typeof value === "string" && value.trim() ? value.trim() : "qfq";
}

function inferSource(ctx: OpenClawPluginToolContext) {
  const sessionKey = ctx.sessionKey?.trim() ?? "";
  if (/(?:^|:)cron:/.test(sessionKey)) {
    return "openclaw_cron";
  }
  return "feishu_manual";
}

function readStages(params: Record<string, unknown>) {
  const value = params.stages;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const stages = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return stages.length > 0 ? stages.map((entry) => entry.trim()) : undefined;
}

function readChainKey(params: Record<string, unknown>) {
  const value = params.chain_key;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function defaultIdempotencyKey(params: {
  startDate: string;
  endDate: string;
  chainKey?: string;
  stages?: string[];
}) {
  const datePart =
    params.startDate === params.endDate
      ? compactDate(params.endDate)
      : `${compactDate(params.startDate)}-${compactDate(params.endDate)}`;
  if (params.stages?.length) {
    return `quotation:stages:${params.stages.join("+")}:${datePart}`;
  }
  return `quotation:${params.chainKey ?? "custom"}:${datePart}`;
}

function createRemoteTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext, def: ToolDef) {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      const payload = await invokePatternQuotationTool({
        pluginConfig: api.pluginConfig as PatternQuotationPluginConfig | undefined,
        toolName: def.remoteToolName,
        args: def.args(params, ctx),
      });
      return formatPatternQuotationResult({
        remoteToolName: def.remoteToolName,
        payload,
      });
    },
  };
}

const toolDefs: ToolDef[] = [
  {
    name: "quotation_refresh_chain",
    label: "Quotation Refresh Chain",
    description:
      "[Quotation sub-service][market/information refresh] Start a configurable quotation task chain. Use chain_key for configured chains such as pre_market/post_open, or stages for an explicit stage list.",
    remoteToolName: "quotation.refresh_run",
    parameters: objectSchema({
      chain_key: stringSchema(),
      stages: arrayOfStringSchema(),
      start_date: stringSchema(),
      end_date: stringSchema(),
      include_symbols: stringSchema(),
      symbols: arrayOfStringSchema(),
      adjust: stringSchema(),
      max_workers: numberSchema(),
      source: stringSchema(),
      idempotency_key: stringSchema(),
    }),
    args(params, ctx) {
      const chainKey = readChainKey(params);
      const stages = readStages(params);
      if (!chainKey && !stages?.length) {
        throw new Error("quotation_refresh_chain requires chain_key or stages");
      }
      const fallbackDate = latestCompletedTradingDate();
      const startDate = readDate(params, "start_date") ?? fallbackDate;
      const endDate = readDate(params, "end_date") ?? fallbackDate;
      const source =
        typeof params.source === "string" && params.source.trim()
          ? params.source.trim()
          : inferSource(ctx);
      const idempotencyKey =
        typeof params.idempotency_key === "string" && params.idempotency_key.trim()
          ? params.idempotency_key.trim()
          : defaultIdempotencyKey({ startDate, endDate, chainKey, stages });
      const args: Record<string, unknown> = {
        start_date: startDate,
        end_date: endDate,
        include_symbols: readSymbols(params),
        symbols: readSymbolsArray(params),
        adjust: readAdjust(params),
        max_workers: readMaxWorkers(params),
        source,
        idempotency_key: idempotencyKey,
      };
      if (stages?.length) {
        args.stages = stages;
      } else {
        args.chain_key = chainKey;
      }
      return args;
    },
  },
  {
    name: "quotation_refresh_get",
    label: "Quotation Refresh Get",
    description:
      "[Quotation sub-service] Get a quotation refresh job status. Omit job_id to read the latest refresh job.",
    remoteToolName: "quotation.refresh_get",
    parameters: objectSchema({ job_id: stringSchema() }),
    args(params) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      return jobId ? { job_id: jobId } : {};
    },
  },
  {
    name: "quotation_refresh_errors",
    label: "Quotation Refresh Errors",
    description:
      "[Quotation sub-service] List per-symbol refresh failures for a job. Use after status reports failed_symbols greater than zero.",
    remoteToolName: "quotation.refresh_errors",
    parameters: objectSchema({ job_id: stringSchema(), limit: numberSchema() }, ["job_id"]),
    args(params) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : 100;
      return { job_id: jobId, limit };
    },
  },
];

export function createPatternQuotationTools(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
) {
  return [
    ...toolDefs.map((def) => createRemoteTool(api, ctx, def)),
    ...createPatternQuotationLocalTools(api, ctx),
  ];
}
