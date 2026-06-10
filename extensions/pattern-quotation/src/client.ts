type PatternQuotationPluginConfig = {
  baseUrl?: string;
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

function resolveBaseUrl(config?: PatternQuotationPluginConfig): string {
  const baseUrl = config?.baseUrl?.trim() || "http://127.0.0.1:18080";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ToolInputError("Pattern Quotation plugin baseUrl is invalid");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new ToolInputError("Pattern Quotation plugin baseUrl must use http or https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function resolveTimeoutMs(config?: PatternQuotationPluginConfig): number {
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
    throw new Error(`Pattern Quotation service returned non-JSON response (${response.status})`);
  }
}

export async function invokePatternQuotationTool(params: {
  pluginConfig?: PatternQuotationPluginConfig;
  toolName: string;
  args?: Record<string, unknown>;
}): Promise<RemoteToolEnvelope> {
  const baseUrl = resolveBaseUrl(params.pluginConfig);
  const timeoutMs = resolveTimeoutMs(params.pluginConfig);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/tools/${encodeURIComponent(params.toolName)}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        arguments: params.args ?? {},
        context: {
          source: "openclaw_plugin",
        },
      }),
      signal: controller.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      const message =
        payload.error?.message?.trim() ||
        `Pattern Quotation service returned HTTP ${response.status}`;
      const code = payload.error?.code?.trim();
      throw new Error(code ? `${code}: ${message}` : message);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Pattern Quotation service timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function formatPatternQuotationResult(params: {
  remoteToolName: string;
  payload: RemoteToolEnvelope;
}) {
  if (params.payload.ok === false) {
    const code = params.payload.error?.code?.trim();
    const message = params.payload.error?.message?.trim() || "Remote tool call failed";
    const retryable =
      typeof params.payload.error?.retryable === "boolean"
        ? ` (retryable=${String(params.payload.error.retryable)})`
        : "";
    throw new Error(code ? `${code}: ${message}${retryable}` : `${message}${retryable}`);
  }

  const result = {
    service: "Pattern Quotation",
    tags: ["quotation-subservice", "market-refresh", "information-refresh"],
    tool_name: params.payload.tool_name ?? params.remoteToolName,
    ok: params.payload.ok ?? true,
    data: params.payload.data,
    meta: params.payload.meta,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: {
      remoteToolName: params.remoteToolName,
      remote: params.payload,
      data: params.payload.data,
    },
  };
}
