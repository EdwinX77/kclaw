import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../../../src/plugins/types.js";

export type PatternStrategyPluginConfig = {
  baseUrl?: string;
  chartBaseUrl?: string;
  timeoutMs?: number;
};

class ToolInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

type RemoteToolEnvelope = {
  ok?: boolean;
  tool_name?: string;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: unknown;
  };
  meta?: unknown;
};

type PatternStrategyMcpLogContext = {
  taskKey?: string;
  idempotencyKey?: string;
  source?: string;
  requestedBy?: string;
  traceId?: string;
  triggerType?: string;
};

function resolveHttpBaseUrl(rawUrl: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolInputError(`Pattern Strategy plugin ${label} is invalid`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new ToolInputError(`Pattern Strategy plugin ${label} must use http or https`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function resolvePatternStrategyBaseUrl(config?: PatternStrategyPluginConfig): string {
  return resolveHttpBaseUrl(config?.baseUrl?.trim() || "http://127.0.0.1:18080", "baseUrl");
}

function resolvePatternStrategyChartBaseUrl(config?: PatternStrategyPluginConfig): string {
  const explicit = config?.chartBaseUrl?.trim();
  if (explicit) {
    return resolveHttpBaseUrl(explicit, "chartBaseUrl");
  }

  const parsed = new URL(resolvePatternStrategyBaseUrl(config));
  if (parsed.port === "18080") {
    parsed.port = "18000";
  }
  return parsed.toString().replace(/\/+$/, "");
}

function resolveTimeoutMs(config?: PatternStrategyPluginConfig): number {
  const timeoutMs = config?.timeoutMs;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return 30_000;
}

async function parseJsonResponse(response: Response): Promise<RemoteToolEnvelope> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as RemoteToolEnvelope;
  } catch {
    throw new Error(`Pattern Strategy service returned non-JSON response (${response.status})`);
  }
}

export async function invokePatternStrategyTool(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  toolName: string;
  args?: Record<string, unknown>;
  logger?: PluginLogger;
  logContext?: PatternStrategyMcpLogContext;
}): Promise<RemoteToolEnvelope> {
  const baseUrl = resolvePatternStrategyBaseUrl(params.pluginConfig);
  const timeoutMs = resolveTimeoutMs(params.pluginConfig);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let logged = false;

  try {
    const response = await fetch(`${baseUrl}/tools/${encodeURIComponent(params.toolName)}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        arguments: params.args ?? {},
        context: {
          source: "openclaw_agent",
        },
      }),
      signal: controller.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      const message =
        payload.error?.message?.trim() ||
        `Pattern Strategy service returned HTTP ${response.status}`;
      const code = payload.error?.code?.trim();
      logPatternStrategyMcpCall({
        logger: params.logger,
        toolName: params.toolName,
        args: params.args,
        logContext: params.logContext,
        payload,
        errorCode: code ?? `http_${response.status}`,
        errorMessage: message,
      });
      logged = true;
      throw new Error(code ? `${code}: ${message}` : message);
    }
    logPatternStrategyMcpCall({
      logger: params.logger,
      toolName: params.toolName,
      args: params.args,
      logContext: params.logContext,
      payload,
    });
    logged = true;
    return payload;
  } catch (error) {
    if (!logged) {
      logPatternStrategyMcpCall({
        logger: params.logger,
        toolName: params.toolName,
        args: params.args,
        logContext: params.logContext,
        errorCode: error instanceof Error && error.name === "AbortError" ? "timeout" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Pattern Strategy service timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readLogString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function logDataRecord(payload?: RemoteToolEnvelope) {
  return isRecord(payload?.data) ? payload.data : null;
}

function logPatternStrategyMcpCall(params: {
  logger?: PluginLogger;
  toolName: string;
  args?: Record<string, unknown>;
  logContext?: PatternStrategyMcpLogContext;
  payload?: RemoteToolEnvelope;
  errorCode?: string;
  errorMessage?: string;
}) {
  const logger = params.logger;
  if (!logger) {
    return;
  }
  const data = logDataRecord(params.payload);
  const entry = {
    event: "pattern_strategy_mcp_call",
    tool_name: params.toolName,
    task_key: readLogString(params.args?.task_key, params.logContext?.taskKey),
    idempotency_key: readLogString(params.args?.idempotency_key, params.logContext?.idempotencyKey),
    source: readLogString(params.args?.source, params.logContext?.source),
    trigger_type: readLogString(params.args?.trigger_type, params.logContext?.triggerType),
    trace_id: readLogString(params.args?.trace_id, params.logContext?.traceId),
    requested_by: readLogString(params.args?.requested_by, params.logContext?.requestedBy),
    returned_run_id: readLogString(data?.run_id, data?.id),
    returned_job_id: readLogString(data?.job_id),
    returned_status: readLogString(data?.status),
    error_code: params.errorCode,
    error_message: params.errorMessage,
  };
  logger.info(JSON.stringify(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizePatternStrategyChartUrl(
  value: string,
  config?: PatternStrategyPluginConfig,
): string {
  const chartBaseUrl = resolvePatternStrategyChartBaseUrl(config);
  let parsed: URL;
  try {
    parsed = new URL(value, chartBaseUrl);
  } catch {
    return value;
  }

  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
    const base = new URL(chartBaseUrl);
    parsed.protocol = base.protocol;
    parsed.hostname = base.hostname;
    parsed.port = base.port;
  }

  return parsed.toString();
}

function sanitizeChartFileName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.slice(0, 120);
}

function resolveChartFileName(params: { chartUrl: string; chartPath?: unknown }): string {
  const sourcePath =
    typeof params.chartPath === "string" && params.chartPath.trim()
      ? params.chartPath.trim()
      : new URL(params.chartUrl).pathname;
  const basename = sanitizeChartFileName(path.basename(sourcePath));
  if (basename && path.extname(basename)) {
    return basename;
  }

  const hash = crypto.createHash("sha256").update(params.chartUrl).digest("hex").slice(0, 16);
  return `chan-chart-${hash}.png`;
}

async function downloadChartToLocalMedia(params: {
  chartUrl: string;
  chartPath?: unknown;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(params.chartUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Chart image download failed with HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`Chart image download returned non-image content-type: ${contentType}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Chart image download returned an empty body");
    }
    const maxBytes = 30 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new Error("Chart image exceeds 30MB limit");
    }

    const dir = path.join("/tmp/openclaw", "pattern-chan", "charts");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(
      dir,
      `${Date.now()}-${resolveChartFileName({
        chartUrl: params.chartUrl,
        chartPath: params.chartPath,
      })}`,
    );
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    return filePath;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Chart image download timed out after ${params.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function normalizePatternStrategyPayload(params: {
  remoteToolName: string;
  payload: RemoteToolEnvelope;
  pluginConfig?: PatternStrategyPluginConfig;
}): Promise<RemoteToolEnvelope> {
  if (params.remoteToolName !== "chan.generate_chart" || !isRecord(params.payload.data)) {
    return params.payload;
  }

  const chartUrl = params.payload.data.chart_url;
  if (typeof chartUrl !== "string" || !chartUrl.trim()) {
    return params.payload;
  }

  const normalizedChartUrl = normalizePatternStrategyChartUrl(chartUrl.trim(), params.pluginConfig);
  const chartMediaPath = await downloadChartToLocalMedia({
    chartUrl: normalizedChartUrl,
    chartPath: params.payload.data.chart_path,
    timeoutMs: resolveTimeoutMs(params.pluginConfig),
  });

  return {
    ...params.payload,
    data: {
      ...params.payload.data,
      chart_url: normalizedChartUrl,
      chart_media_path: chartMediaPath,
    },
  };
}

function redactVisibleChanChartData(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  const visible: Record<string, unknown> = {
    symbol: typeof data.symbol === "string" ? data.symbol : undefined,
    security_name: typeof data.security_name === "string" ? data.security_name : undefined,
    start_date: typeof data.start_date === "string" ? data.start_date : undefined,
    end_date: typeof data.end_date === "string" ? data.end_date : undefined,
    delivery_instruction:
      "Chan chart image is staged in tool details and will be delivered by OpenClaw automatically. Do not print any internal URL, path, raw chart field, MEDIA directive, or Markdown image link. Add a concise Chan-theory reading covering current stage, approximate box/central-zone bounds, and overall structure. Keep it short and avoid trading advice.",
  };

  return Object.fromEntries(Object.entries(visible).filter(([, value]) => value !== undefined));
}

function buildChanChartMediaDetails(params: {
  remoteToolName: string;
  payload: RemoteToolEnvelope;
}): { mediaUrl: string; mediaUrls: string[]; trustedLocalMedia: true } | undefined {
  if (params.remoteToolName !== "chan.generate_chart" || !isRecord(params.payload.data)) {
    return undefined;
  }
  const mediaPath = params.payload.data.chart_media_path;
  if (typeof mediaPath !== "string") {
    return undefined;
  }
  const normalized = mediaPath.trim();
  if (!normalized) {
    return undefined;
  }
  return {
    mediaUrl: normalized,
    mediaUrls: [normalized],
    trustedLocalMedia: true,
  };
}

export async function formatPatternStrategyResult(params: {
  remoteToolName: string;
  payload: RemoteToolEnvelope;
  pluginConfig?: PatternStrategyPluginConfig;
}) {
  const payload = await normalizePatternStrategyPayload(params);

  if (payload.ok === false) {
    const code = payload.error?.code?.trim();
    const message = payload.error?.message?.trim() || "Remote tool call failed";
    const retryable =
      typeof payload.error?.retryable === "boolean"
        ? ` (retryable=${String(payload.error.retryable)})`
        : "";
    throw new Error(code ? `${code}: ${message}${retryable}` : `${message}${retryable}`);
  }

  const result = {
    tool_name: payload.tool_name ?? params.remoteToolName,
    ok: payload.ok ?? true,
    data:
      params.remoteToolName === "chan.generate_chart"
        ? redactVisibleChanChartData(payload.data)
        : payload.data,
    meta: payload.meta,
  };
  const media = buildChanChartMediaDetails({ remoteToolName: params.remoteToolName, payload });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: {
      remoteToolName: params.remoteToolName,
      remote: payload,
      data: payload.data,
      ...(media ? { media } : {}),
    },
  };
}
