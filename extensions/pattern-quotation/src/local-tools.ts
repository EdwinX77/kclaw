import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { schedulePatternQuotationWatchNow } from "./async-watch-service.js";
import {
  getAsyncWatch,
  listAsyncWatches,
  removeAsyncWatch,
  type AsyncCompletionWakeMode,
  type QuotationRefreshAsyncWatch,
  upsertAsyncWatch,
} from "./async-watch-store.js";
import { readMarketDate } from "./quotation-identity.js";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const stringSchema = () => ({ type: "string" });
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

async function appendAuditRecord(
  api: OpenClawPluginApi,
  record: Record<string, unknown>,
): Promise<void> {
  const filePath = path.join(
    api.runtime.state.resolveStateDir(process.env),
    "logs",
    "agent-interactions.jsonl",
  );
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsPromises.appendFile(filePath, `${JSON.stringify({ ts: Date.now(), ...record })}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function resolveHeartbeatSnapshot(api: OpenClawPluginApi, agentId?: string) {
  const normalizedAgentId = agentId?.trim();
  const agent = api.config.agents?.list?.find((entry) => entry?.id === normalizedAgentId);
  const heartbeat = agent?.heartbeat ?? api.config.agents?.defaults?.heartbeat;
  return {
    enabled: Boolean(heartbeat),
    summary: heartbeat ? { enabled: true, every: heartbeat.every ?? null } : { enabled: false },
  };
}

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
  api: OpenClawPluginApi;
  sessionKey?: string;
  agentId?: string;
}): CompletionDeliverySnapshot | undefined {
  const sessionKey = params.sessionKey?.trim() || params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = params.agentId?.trim() || params.ctx.agentId?.trim();
  try {
    const storePath = params.api.runtime.channel.session.resolveStorePath(
      params.ctx.config?.session?.store,
      {
        agentId,
      },
    );
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, unknown>;
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
  api: OpenClawPluginApi;
  sessionKey?: string;
  agentId?: string;
}) {
  return (
    resolveContextDeliverySnapshot(params.ctx) ??
    resolveSessionDeliverySnapshot({
      ctx: params.ctx,
      api: params.api,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    })
  );
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

function isCronSession(ctx: OpenClawPluginToolContext) {
  return /(?:^|:)cron:/.test(ctx.sessionKey?.trim() ?? "");
}

const localToolDefs: LocalToolDef[] = [
  {
    name: "quotation_watch_refresh",
    label: "Quotation Watch Refresh",
    description:
      "[Quotation sub-service] Register an async watcher for a Pattern Quotation refresh job. On completion it enqueues a system event and wakes heartbeat for the originating session.",
    parameters: objectSchema(
      {
        job_id: stringSchema(),
        source: stringSchema(),
        request_key: stringSchema(),
        run_label: stringSchema(),
        session_key: stringSchema(),
        agent_id: stringSchema(),
        wake_mode: stringEnumSchema(["now", "next-heartbeat"]),
        refresh_date: stringSchema(),
      },
      ["job_id"],
    ),
    async execute(ctx, params, api) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      if (!jobId) {
        throw new Error("quotation_watch_refresh requires job_id");
      }
      const sessionKey =
        typeof params.session_key === "string" && params.session_key.trim()
          ? params.session_key.trim()
          : ctx.sessionKey?.trim();
      if (!sessionKey) {
        throw new Error(
          "quotation_watch_refresh requires session_key when no current session is available",
        );
      }
      const agentId =
        typeof params.agent_id === "string" && params.agent_id.trim()
          ? params.agent_id.trim()
          : ctx.agentId?.trim();
      if (!agentId) {
        throw new Error(
          "quotation_watch_refresh requires agent_id when no current agent is available",
        );
      }
      const wakeMode =
        typeof params.wake_mode === "string" && params.wake_mode.trim() === "next-heartbeat"
          ? ("next-heartbeat" as AsyncCompletionWakeMode)
          : ("now" as AsyncCompletionWakeMode);
      const cronWatch = isCronSession(ctx) || readString(params, "source") === "openclaw_cron";
      const source = readString(params, "source") ?? (cronWatch ? "openclaw_cron" : undefined);
      const requestKey = readString(params, "request_key");
      const refreshDate = readMarketDate(params.refresh_date);
      if (params.refresh_date !== undefined && !refreshDate) {
        throw new Error("quotation_watch_refresh refresh_date must be YYYY-MM-DD");
      }
      if (cronWatch && (!requestKey || !refreshDate)) {
        throw new Error(
          "quotation_watch_refresh requires the backend-returned request_key and refresh_date for cron jobs",
        );
      }
      if (cronWatch && !requestKey?.endsWith(`:${refreshDate?.replaceAll("-", "")}`)) {
        throw new Error("quotation_watch_refresh request_key does not match refresh_date");
      }
      const now = Date.now();
      const watch: QuotationRefreshAsyncWatch = {
        kind: "quotation_refresh",
        jobId,
        sessionKey,
        agentId,
        wakeMode,
        followupMode: "heartbeat-system-event",
        source,
        requestKey,
        runLabel: readString(params, "run_label"),
        refreshDate,
        registeredAt: now,
        updatedAt: now,
      };
      const deliverySnapshot = resolveCompletionDeliverySnapshot({ ctx, api, sessionKey, agentId });
      if (deliverySnapshot) {
        watch.deliverySnapshot = deliverySnapshot;
      }
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      await upsertAsyncWatch({ stateDir, watch });
      await appendAuditRecord(api, {
        kind: "async_watch_registered",
        requesterSessionKey: ctx.sessionKey,
        sessionKey: watch.sessionKey,
        agentId: watch.agentId,
        jobId: watch.jobId,
        status: "registered",
        summary: "registered quotation async watch",
        data: {
          source: watch.source,
          requestKey: watch.requestKey,
          runLabel: watch.runLabel,
          wakeMode: watch.wakeMode,
          refreshDate: watch.refreshDate,
          deliverySnapshot: watch.deliverySnapshot ?? null,
        },
      });
      schedulePatternQuotationWatchNow({ api, stateDir, watch });
      const heartbeat = resolveHeartbeatSnapshot(api, watch.agentId);
      return formatLocalToolResult({
        ok: true,
        service: "Pattern Quotation",
        tags: ["quotation-subservice", "market-refresh", "information-refresh"],
        watch: {
          job_id: watch.jobId,
          source: watch.source,
          session_key: watch.sessionKey,
          agent_id: watch.agentId,
          wake_mode: watch.wakeMode,
          refresh_date: watch.refreshDate,
          heartbeat_enabled: heartbeat.enabled,
          heartbeat_summary: heartbeat.summary,
          delivery_snapshot: watch.deliverySnapshot ?? null,
        },
      });
    },
  },
  {
    name: "quotation_get_watch",
    label: "Quotation Get Watch",
    description:
      "[Quotation sub-service] Get the registered async watcher state for a refresh job.",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
    async execute(_ctx, params, api) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      if (!jobId) {
        throw new Error("quotation_get_watch requires job_id");
      }
      const watch = await getAsyncWatch({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        jobId,
      });
      return formatLocalToolResult({
        ok: true,
        service: "Pattern Quotation",
        watch,
      });
    },
  },
  {
    name: "quotation_unwatch_refresh",
    label: "Quotation Unwatch Refresh",
    description: "[Quotation sub-service] Remove a registered async watcher for a refresh job.",
    parameters: objectSchema({ job_id: stringSchema() }, ["job_id"]),
    async execute(_ctx, params, api) {
      const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
      if (!jobId) {
        throw new Error("quotation_unwatch_refresh requires job_id");
      }
      const removed = await removeAsyncWatch({
        stateDir: api.runtime.state.resolveStateDir(process.env),
        jobId,
      });
      await appendAuditRecord(api, {
        kind: "async_watch_completed",
        requesterSessionKey: _ctx.sessionKey,
        sessionKey: _ctx.sessionKey,
        agentId: _ctx.agentId,
        jobId,
        status: removed ? "removed" : "missing",
        summary: "removed quotation async watch registration",
      });
      return formatLocalToolResult({
        ok: true,
        service: "Pattern Quotation",
        removed,
        job_id: jobId,
      });
    },
  },
  {
    name: "quotation_list_watches",
    label: "Quotation List Watches",
    description:
      "[Quotation sub-service] List registered async Pattern Quotation refresh watchers.",
    parameters: objectSchema({}),
    async execute(_ctx, _params, api) {
      const watches = await listAsyncWatches(api.runtime.state.resolveStateDir(process.env));
      return formatLocalToolResult({
        ok: true,
        service: "Pattern Quotation",
        watches,
      });
    },
  },
];

export function createPatternQuotationLocalTools(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
) {
  return localToolDefs.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      return await def.execute(ctx, params, api);
    },
  }));
}
