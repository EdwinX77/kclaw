import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { formatPatternQuotationResult, invokePatternQuotationTool } from "./client.js";
import { createPatternQuotationLocalTools } from "./local-tools.js";
import {
  buildQuotationIdempotencyKey,
  isRecord,
  MARKET_TIMEZONE,
  readMarketDate,
} from "./quotation-identity.js";

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

function isCronContext(ctx: OpenClawPluginToolContext) {
  return inferSource(ctx) === "openclaw_cron";
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

type RemotePayload = Awaited<ReturnType<typeof invokePatternQuotationTool>>;

function readRequiredCanonicalString(data: Record<string, unknown>, key: string) {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`quotation.refresh_run returned no canonical ${key}`);
  }
  return value.trim();
}

function withCanonicalRefreshMetadata(params: {
  payload: RemotePayload;
  submittedArgs: Record<string, unknown>;
}) {
  if (params.payload.ok === false) {
    return params.payload;
  }
  if (!isRecord(params.payload.data)) {
    throw new Error("quotation.refresh_run returned no canonical job data");
  }
  const data = params.payload.data;
  const startDate = readMarketDate(data.start_date);
  const endDate = readMarketDate(data.end_date);
  if (!startDate || !endDate) {
    throw new Error("quotation.refresh_run returned invalid canonical start_date/end_date");
  }
  const requestKey =
    typeof data.idempotency_key === "string" && data.idempotency_key.trim()
      ? data.idempotency_key.trim()
      : undefined;
  readRequiredCanonicalString(data, "job_id");
  const cronSubmission = params.submittedArgs.source === "openclaw_cron";
  if (cronSubmission && !requestKey) {
    throw new Error("quotation.refresh_run returned no canonical idempotency_key");
  }

  const expected = {
    start_date: readMarketDate(params.submittedArgs.start_date),
    end_date: readMarketDate(params.submittedArgs.end_date),
    idempotency_key:
      typeof params.submittedArgs.idempotency_key === "string"
        ? params.submittedArgs.idempotency_key.trim()
        : undefined,
  };
  const canonical = { start_date: startDate, end_date: endDate, idempotency_key: requestKey };
  const mismatched = Object.entries(expected)
    .filter(([, value]) => value !== undefined)
    .filter(([key, value]) => canonical[key as keyof typeof canonical] !== value)
    .map(([key]) => key);
  if (mismatched.length > 0) {
    throw new Error(
      `quotation.refresh_run canonical response mismatched submitted request: ${mismatched.join(", ")}`,
    );
  }

  return {
    ...params.payload,
    data: {
      ...data,
      requested_start_date: startDate,
      requested_end_date: endDate,
      ...(requestKey ? { request_key: requestKey } : {}),
      market_timezone: MARKET_TIMEZONE,
    },
  };
}

function createRemoteTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext, def: ToolDef) {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      const args = def.args(params, ctx);
      const payload = await invokePatternQuotationTool({
        pluginConfig: api.pluginConfig as PatternQuotationPluginConfig | undefined,
        toolName: def.remoteToolName,
        args,
      });
      const effectivePayload =
        def.remoteToolName === "quotation.refresh_run"
          ? withCanonicalRefreshMetadata({ payload, submittedArgs: args })
          : payload;
      return formatPatternQuotationResult({
        remoteToolName: def.remoteToolName,
        payload: effectivePayload,
      });
    },
  };
}

const toolDefs: ToolDef[] = [
  {
    name: "quotation_refresh_chain",
    label: "Quotation Refresh Chain",
    description:
      "[Quotation sub-service][market/information refresh] Start a configurable quotation task chain. In cron sessions, pass only chain_key or stages: the bridge forces source=openclaw_cron while the Pattern backend resolves the chain-specific Asia/Shanghai business dates and canonical idempotency key. Model-supplied cron dates and keys are ignored. Use chain_key for configured chains such as pre_market/post_open, or stages for an explicit stage list.",
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
      const cronContext = isCronContext(ctx);
      const startDate = readDate(params, "start_date");
      const endDate = readDate(params, "end_date");
      if (!cronContext && Boolean(startDate) !== Boolean(endDate)) {
        throw new Error("quotation_refresh_chain requires start_date and end_date together");
      }
      const source = cronContext
        ? "openclaw_cron"
        : typeof params.source === "string" && params.source.trim()
          ? params.source.trim()
          : inferSource(ctx);
      const args: Record<string, unknown> = {
        include_symbols: readSymbols(params),
        symbols: readSymbolsArray(params),
        adjust: readAdjust(params),
        max_workers: readMaxWorkers(params),
        source,
      };
      if (!cronContext && startDate && endDate) {
        args.start_date = startDate;
        args.end_date = endDate;
        args.idempotency_key =
          typeof params.idempotency_key === "string" && params.idempotency_key.trim()
            ? params.idempotency_key.trim()
            : buildQuotationIdempotencyKey({ startDate, endDate, chainKey, stages });
      } else if (
        !cronContext &&
        typeof params.idempotency_key === "string" &&
        params.idempotency_key.trim()
      ) {
        args.idempotency_key = params.idempotency_key.trim();
      }
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
