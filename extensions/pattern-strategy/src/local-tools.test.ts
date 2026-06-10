import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { getAsyncWatch } from "./async-watch-store.js";
import { getIndiceAsyncWatch } from "./indice-watch-store.js";
import { createPatternStrategyLocalTools } from "./local-tools.js";

let tmpDir: string;
let previousStateDir: string | undefined;

async function writeSessionStore(sessionKey: string) {
  const storePath = path.join(tmpDir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        [sessionKey]: {
          sessionId: "session-1",
          sessionKey,
          agentId: "tas-dispatch",
          updatedAt: Date.now(),
          lastChannel: "feishu",
          lastTo: "oc_group",
          lastAccountId: "main",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return storePath;
}

function createApi(storePath: string): OpenClawPluginApi {
  return {
    config: {
      session: { store: storePath },
      agents: { list: [{ id: "tas-dispatch" }] },
    },
    runtime: {
      state: {
        resolveStateDir: () => tmpDir,
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as OpenClawPluginApi;
}

describe("Pattern Strategy local watch tools", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-strategy-tools-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ignores bogus session keys and preserves enrichment for daily scans", async () => {
    const sessionKey = "agent:tas-dispatch:cron:mid-term-accel";
    const storePath = await writeSessionStore(sessionKey);
    const ctx: OpenClawPluginToolContext = {
      config: { session: { store: storePath } },
      agentId: "tas-dispatch",
      sessionKey,
    };
    const api = createApi(storePath);
    const tool = createPatternStrategyLocalTools(api, ctx).find(
      (candidate) => candidate.name === "strategy_watch_run",
    );
    if (!tool) {
      throw new Error("missing strategy_watch_run");
    }

    const result = await tool.execute("call-1", {
      job_id: "claw_test",
      task_key: "strategy.mid_term_accel.daily_scan",
      idempotency_key: "cron-mid-term-accel-2026-05-29",
      source: "openclaw_cron",
      requested_by: "openclaw_gateway",
      trace_id: "trace-watch-1",
      trigger_type: "cron",
      session_key: "ta_not_a_real_session",
      wake_mode: "next-heartbeat",
      enrich_signals: false,
      max_signals: 0,
    });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.watch.session_key).toBe(sessionKey);
    expect(parsed.watch.idempotency_key).toBe("cron-mid-term-accel-2026-05-29");
    expect(parsed.watch.source).toBe("openclaw_cron");
    expect(parsed.watch.requested_by).toBe("openclaw_gateway");
    expect(parsed.watch.trace_id).toBe("trace-watch-1");
    expect(parsed.watch.trigger_type).toBe("cron");
    expect(parsed.watch.market_date).toBe("2026-05-29");
    expect(parsed.watch.enrich_signals).toBe(true);
    expect(parsed.watch.max_signals).toBe(20);
    expect(parsed.watch.delivery_snapshot.lastTo).toBe("oc_group");

    const watch = await getAsyncWatch({ stateDir: tmpDir, jobId: "claw_test" });
    expect(watch?.followupMode).toBe("direct-agent-delivery");
    expect(watch?.idempotencyKey).toBe("cron-mid-term-accel-2026-05-29");
    expect(watch?.traceId).toBe("trace-watch-1");
  });

  it("forces enrichment for strong pivot breakout daily scan watches", async () => {
    const sessionKey = "agent:tas-dispatch:cron:strong-pivot-breakout";
    const storePath = await writeSessionStore(sessionKey);
    const ctx: OpenClawPluginToolContext = {
      config: { session: { store: storePath } },
      agentId: "tas-dispatch",
      sessionKey,
    };
    const api = createApi(storePath);
    const tool = createPatternStrategyLocalTools(api, ctx).find(
      (candidate) => candidate.name === "strategy_watch_run",
    );
    if (!tool) {
      throw new Error("missing strategy_watch_run");
    }

    const result = await tool.execute("call-strong-pivot-watch", {
      job_id: "claw_strong_pivot",
      task_key: "strategy.strong_pivot_breakout.daily_scan",
      enrich_signals: false,
    });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.watch.enrich_signals).toBe(true);

    const watch = await getAsyncWatch({ stateDir: tmpDir, jobId: "claw_strong_pivot" });
    expect(watch?.enrichSignals).toBe(true);
    expect(watch?.maxSignals).toBe(20);
  });

  it("registers indice refresh watches with Feishu delivery snapshot", async () => {
    const sessionKey = "agent:tas-dispatch:cron:board-index";
    const storePath = await writeSessionStore(sessionKey);
    const ctx: OpenClawPluginToolContext = {
      config: { session: { store: storePath } },
      agentId: "tas-dispatch",
      sessionKey,
    };
    const api = createApi(storePath);
    const tool = createPatternStrategyLocalTools(api, ctx).find(
      (candidate) => candidate.name === "indice_watch_refresh",
    );
    if (!tool) {
      throw new Error("missing indice_watch_refresh");
    }

    const result = await tool.execute("call-indice-watch", {
      job_id: "indice_job_1",
      source: "openclaw_cron",
      request_key: "indice-daily-20260525",
      wake_mode: "now",
    });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.watch.session_key).toBe(sessionKey);
    expect(parsed.watch.delivery_snapshot.lastChannel).toBe("feishu");
    expect(parsed.watch.delivery_snapshot.lastTo).toBe("oc_group");

    const watch = await getIndiceAsyncWatch({ stateDir: tmpDir, jobId: "indice_job_1" });
    expect(watch?.source).toBe("openclaw_cron");
    expect(watch?.deliverySnapshot?.to).toBe("oc_group");
  });
});
