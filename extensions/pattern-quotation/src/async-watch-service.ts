import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginService } from "../../../src/plugins/types.js";
import {
  listAsyncWatches,
  type QuotationRefreshAsyncWatch,
  updateAsyncWatch,
} from "./async-watch-store.js";
import { formatPatternQuotationResult, invokePatternQuotationTool } from "./client.js";

type PatternQuotationPluginConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  asyncPollSeconds?: number;
};

type WatchServiceState = {
  stopRequested: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
  stateDir?: string;
};

const QUOTATION_TERMINAL_STATUSES = new Set(["completed", "partial_failed", "failed"]);
const DEFAULT_POLL_MS = 15_000;
const MIN_POLL_MS = 5_000;

function resolvePollMs(config?: PatternQuotationPluginConfig) {
  const seconds = config?.asyncPollSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.max(MIN_POLL_MS, Math.floor(seconds * 1000));
  }
  return DEFAULT_POLL_MS;
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  return value.trim().toLowerCase() || "unknown";
}

function normalizeOutboundChannel(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const channel = value.trim().toLowerCase();
  if (!channel || channel === "last" || channel === "unknown" || channel === "none") {
    return undefined;
  }
  return channel;
}

async function appendAuditRecord(
  api: OpenClawPluginApi,
  record: Record<string, unknown>,
): Promise<void> {
  const filePath = path.join(
    api.runtime.state.resolveStateDir(process.env),
    "logs",
    "agent-interactions.jsonl",
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify({ ts: Date.now(), ...record })}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function resolveConfigSecret(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/i.exec(trimmed);
  if (match) {
    return process.env[match[1]]?.trim() || undefined;
  }
  return trimmed || undefined;
}

function resolveFeishuAccountId(api: OpenClawPluginApi, accountId?: string) {
  const feishuConfig = (api.config.channels?.feishu ?? {}) as {
    accounts?: Record<string, Record<string, unknown> | undefined>;
    [key: string]: unknown;
  };
  const explicitAccountId = accountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const accounts = feishuConfig.accounts ?? {};
  if (accounts.main) {
    return "main";
  }
  if (accounts.default) {
    return "default";
  }
  const configuredAccountIds = Object.entries(accounts)
    .filter(([, account]) => Boolean(account?.appId) && Boolean(account?.appSecret))
    .map(([id]) => id);
  return configuredAccountIds.length === 1 ? configuredAccountIds[0] : "default";
}

function resolveFeishuAccountConfig(api: OpenClawPluginApi, accountId?: string) {
  const feishuConfig = (api.config.channels?.feishu ?? {}) as {
    accounts?: Record<string, Record<string, unknown> | undefined>;
    [key: string]: unknown;
  };
  const resolvedAccountId = resolveFeishuAccountId(api, accountId);
  const account = feishuConfig.accounts?.[resolvedAccountId] ?? {};
  const merged = { ...feishuConfig, ...account };
  return {
    accountId: resolvedAccountId,
    appId: resolveConfigSecret(merged.appId),
    appSecret: resolveConfigSecret(merged.appSecret),
    domain: typeof merged.domain === "string" ? merged.domain.trim() : "feishu",
  };
}

function normalizeFeishuTarget(raw: string) {
  const trimmed = raw.trim();
  if (/^chat:/i.test(trimmed)) {
    return trimmed.slice("chat:".length).trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.slice("user:".length).trim();
  }
  if (/^open_id:/i.test(trimmed)) {
    return trimmed.slice("open_id:".length).trim();
  }
  return trimmed;
}

function resolveFeishuReceiveIdType(id: string) {
  if (id.startsWith("oc_")) {
    return "chat_id";
  }
  if (id.startsWith("ou_")) {
    return "open_id";
  }
  return "user_id";
}

function resolveFeishuApiBase(domain?: string) {
  if (domain === "lark") {
    return "https://open.larksuite.com";
  }
  if (domain && domain !== "feishu") {
    return domain.replace(/\/+$/, "");
  }
  return "https://open.feishu.cn";
}

async function deliverFeishuText(params: {
  api: OpenClawPluginApi;
  to: string;
  accountId?: string;
  text: string;
}) {
  const account = resolveFeishuAccountConfig(params.api, params.accountId);
  if (!account.appId || !account.appSecret) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const baseUrl = resolveFeishuApiBase(account.domain);
  const tokenResponse = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
  });
  const tokenPayload = (await tokenResponse.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if (!tokenResponse.ok || tokenPayload.code !== 0 || !tokenPayload.tenant_access_token) {
    throw new Error(`Feishu token request failed: ${tokenPayload.msg ?? tokenResponse.status}`);
  }
  const receiveId = normalizeFeishuTarget(params.to);
  const receiveIdType = resolveFeishuReceiveIdType(receiveId);
  const sendResponse = await fetch(
    `${baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenPayload.tenant_access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: "md", text: params.text }]],
          },
        }),
      }),
    },
  );
  const sendPayload = (await sendResponse.json()) as {
    code?: number;
    msg?: string;
    data?: { message_id?: string };
  };
  if (!sendResponse.ok || sendPayload.code !== 0) {
    throw new Error(`Feishu send failed: ${sendPayload.msg ?? sendResponse.status}`);
  }
  return sendPayload.data?.message_id ?? "feishu-message";
}

async function deliverViaSdkIfAvailable(params: {
  api: OpenClawPluginApi;
  watch: QuotationRefreshAsyncWatch;
  channel: string;
  to: string;
  accountId?: string;
  text: string;
}) {
  const sdk = (await import("openclaw/plugin-sdk")) as Record<string, unknown>;
  const deliver = sdk.deliverOutboundPayloads;
  if (typeof deliver !== "function") {
    return null;
  }
  const buildSession = sdk.buildOutboundSessionContext;
  const resolveIdentity = sdk.resolveAgentOutboundIdentity;
  const results = await deliver({
    cfg: params.api.config,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: [{ text: params.text }],
    session:
      typeof buildSession === "function"
        ? buildSession({
            cfg: params.api.config,
            agentId: params.watch.agentId,
            sessionKey: params.watch.sessionKey,
          })
        : { key: params.watch.sessionKey, agentId: params.watch.agentId },
    identity:
      typeof resolveIdentity === "function"
        ? resolveIdentity(params.api.config, params.watch.agentId)
        : undefined,
    bestEffort: true,
    mirror: {
      sessionKey: params.watch.sessionKey,
      agentId: params.watch.agentId,
      text: params.text,
    },
  });
  return Array.isArray(results) && results.length > 0 ? "delivered" : "not-delivered";
}

function buildQuotationTerminalNotification(params: {
  watch: QuotationRefreshAsyncWatch;
  runData: Record<string, unknown> | null;
  status: string;
  errors: unknown[];
}) {
  const ok = params.status === "completed" || params.status === "partial_failed";
  const lines = [
    ok ? "Pattern Quotation 行情服务已执行完成。" : "Pattern Quotation 行情服务执行失败。",
    `job_id: ${params.watch.jobId}`,
    params.watch.requestKey ? `request_key: ${params.watch.requestKey}` : null,
    params.watch.runLabel ? `run_label: ${params.watch.runLabel}` : null,
    params.watch.source ? `source: ${params.watch.source}` : null,
    `status: ${params.status}`,
    params.runData?.stage ? `stage: ${String(params.runData.stage)}` : null,
    params.runData?.progress != null ? `progress: ${String(params.runData.progress)}` : null,
    params.runData?.task_progress
      ? `task_progress: ${JSON.stringify(params.runData.task_progress)}`
      : null,
    params.runData?.heartbeat_at ? `heartbeat_at: ${String(params.runData.heartbeat_at)}` : null,
    params.runData?.start_date ? `start_date: ${String(params.runData.start_date)}` : null,
    params.runData?.end_date ? `end_date: ${String(params.runData.end_date)}` : null,
    params.runData?.event_row_count != null
      ? `event_row_count: ${String(params.runData.event_row_count)}`
      : null,
    params.runData?.margin_record_count != null
      ? `margin_record_count: ${String(params.runData.margin_record_count)}`
      : null,
    params.runData?.margin_failed_count != null
      ? `margin_failed_count: ${String(params.runData.margin_failed_count)}`
      : null,
    params.runData?.failed_symbols != null
      ? `failed_symbols: ${String(params.runData.failed_symbols)}`
      : null,
    params.runData?.message ? `message: ${String(params.runData.message)}` : null,
    `error_count: ${params.errors.length}`,
    params.errors.length > 0
      ? `error_preview_json: ${JSON.stringify(params.errors.slice(0, 5))}`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

async function deliverDeterministicUpdate(params: {
  api: OpenClawPluginApi;
  watch: QuotationRefreshAsyncWatch;
  text: string;
}) {
  const channel = normalizeOutboundChannel(params.watch.deliverySnapshot?.channel);
  const to = params.watch.deliverySnapshot?.to?.trim();
  if (!channel || !to) {
    return "not-requested" as const;
  }
  try {
    const accountId =
      channel === "feishu"
        ? resolveFeishuAccountId(params.api, params.watch.deliverySnapshot?.accountId)
        : params.watch.deliverySnapshot?.accountId;
    const sdkStatus = await deliverViaSdkIfAvailable({ ...params, channel, to, accountId });
    if (sdkStatus) {
      return sdkStatus;
    }
    if (channel === "feishu") {
      await deliverFeishuText({
        api: params.api,
        to,
        accountId,
        text: params.text,
      });
      return "delivered" as const;
    }
    return "not-delivered" as const;
  } catch (error) {
    params.api.logger.warn(
      `pattern-quotation deterministic delivery failed for ${params.watch.jobId}: ${String(error)}`,
    );
    return "not-delivered" as const;
  }
}

async function fetchQuotationStatus(params: {
  pluginConfig?: PatternQuotationPluginConfig;
  jobId: string;
}) {
  const payload = await invokePatternQuotationTool({
    pluginConfig: params.pluginConfig,
    toolName: "quotation.refresh_get",
    args: { job_id: params.jobId },
  });
  const result = formatPatternQuotationResult({
    remoteToolName: "quotation.refresh_get",
    payload,
  });
  return (result.details?.data ?? null) as Record<string, unknown> | null;
}

async function fetchQuotationErrors(params: {
  pluginConfig?: PatternQuotationPluginConfig;
  jobId: string;
  limit: number;
}) {
  const payload = await invokePatternQuotationTool({
    pluginConfig: params.pluginConfig,
    toolName: "quotation.refresh_errors",
    args: { job_id: params.jobId, limit: params.limit },
  });
  const result = formatPatternQuotationResult({
    remoteToolName: "quotation.refresh_errors",
    payload,
  });
  const data = result.details?.data;
  return Array.isArray(data) ? data : [];
}

async function processQuotationWatch(params: {
  api: OpenClawPluginApi;
  stateDir: string;
  watch: QuotationRefreshAsyncWatch;
}) {
  const runData = await fetchQuotationStatus({
    pluginConfig: params.api.pluginConfig as PatternQuotationPluginConfig | undefined,
    jobId: params.watch.jobId,
  });
  const remoteStatus = normalizeStatus(runData?.status);
  if (!QUOTATION_TERMINAL_STATUSES.has(remoteStatus)) {
    await appendAuditRecord(params.api, {
      kind: "async_watch_progress",
      requesterSessionKey: params.watch.sessionKey,
      sessionKey: params.watch.sessionKey,
      agentId: params.watch.agentId,
      jobId: params.watch.jobId,
      status: remoteStatus,
      summary: "quotation async watch observed a non-terminal status",
      data: {
        source: params.watch.source,
        requestKey: params.watch.requestKey,
        stage: runData?.stage,
        progress: runData?.progress,
      },
    });
    await updateAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
      ...existing,
      lastRemoteStatus: remoteStatus,
      updatedAt: Date.now(),
    }));
    return;
  }

  const failedSymbols =
    typeof runData?.failed_symbols === "number" && Number.isFinite(runData.failed_symbols)
      ? runData.failed_symbols
      : 0;
  const errors =
    failedSymbols > 0
      ? await fetchQuotationErrors({
          pluginConfig: params.api.pluginConfig as PatternQuotationPluginConfig | undefined,
          jobId: params.watch.jobId,
          limit: 20,
        })
      : [];
  const deliveryStatus = await deliverDeterministicUpdate({
    api: params.api,
    watch: params.watch,
    text: buildQuotationTerminalNotification({
      watch: params.watch,
      runData,
      status: remoteStatus,
      errors,
    }),
  });
  await appendAuditRecord(params.api, {
    kind: "async_watch_completed",
    requesterSessionKey: params.watch.sessionKey,
    sessionKey: params.watch.sessionKey,
    agentId: params.watch.agentId,
    jobId: params.watch.jobId,
    status: remoteStatus,
    summary: "quotation async watch completed and delivered deterministic terminal status",
    data: {
      source: params.watch.source,
      requestKey: params.watch.requestKey,
      runLabel: params.watch.runLabel,
      failedSymbols,
      errorCount: errors.length,
      deliveryStatus,
      llmInvoked: false,
    },
  });
  await updateAsyncWatch(params.stateDir, params.watch.jobId, (existing) => ({
    ...existing,
    lastRemoteStatus: remoteStatus,
    deliveryStatus,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  }));
}

export function createPatternQuotationAsyncWatchService(
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
    const delayMs = resolvePollMs(api.pluginConfig as PatternQuotationPluginConfig | undefined);
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
            await processQuotationWatch({ api, stateDir: state.stateDir, watch });
          } catch (error) {
            api.logger.warn(
              `pattern-quotation async watch failed for ${watch.jobId}: ${String(error)}`,
            );
            await appendAuditRecord(api, {
              kind: "async_watch_failed",
              requesterSessionKey: watch.sessionKey,
              sessionKey: watch.sessionKey,
              agentId: watch.agentId,
              jobId: watch.jobId,
              status: "failed",
              summary: "pattern-quotation async watch poll failed",
              data: {
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
      } finally {
        state.running = false;
        schedule();
      }
    }, delayMs);
    state.timer.unref?.();
  };

  return {
    id: "pattern-quotation-async-watch",
    async start(ctx) {
      state.stopRequested = false;
      state.stateDir = ctx.stateDir;
      schedule();
      api.logger.info("pattern-quotation async watch service started");
    },
    async stop() {
      state.stopRequested = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      api.logger.info("pattern-quotation async watch service stopped");
    },
  };
}
