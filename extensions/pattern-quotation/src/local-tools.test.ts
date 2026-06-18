import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { getAsyncWatch } from "./async-watch-store.js";
import { createPatternQuotationLocalTools } from "./local-tools.js";

let tmpDir: string;
let previousStateDir: string | undefined;

async function writeSessionStore(sessionKey: string) {
  const storePath = path.join(tmpDir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        [sessionKey]: {
          sessionId: "session-quotation",
          sessionKey,
          agentId: "tas-dispatch",
          updatedAt: Date.now(),
          lastChannel: "feishu",
          lastTo: "oc_legacy_group",
          lastAccountId: "legacy",
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
      channel: {
        session: {
          resolveStorePath: () => storePath,
        },
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as OpenClawPluginApi;
}

describe("Pattern Quotation local watch tools", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-quotation-tools-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("registers refresh watches with the current delivery context", async () => {
    const sessionKey = "agent:tas-dispatch:cron:market-refresh";
    const storePath = await writeSessionStore(sessionKey);
    const ctx: OpenClawPluginToolContext = {
      config: { session: { store: storePath } },
      agentId: "tas-dispatch",
      sessionKey,
      deliveryContext: {
        channel: "feishu",
        to: "user:ou_market",
        accountId: "main",
        threadId: "thread-market-refresh",
      },
    };
    const api = createApi(storePath);
    const tool = createPatternQuotationLocalTools(api, ctx).find(
      (candidate) => candidate.name === "quotation_watch_refresh",
    );
    if (!tool) {
      throw new Error("missing quotation_watch_refresh");
    }

    const result = await tool.execute("call-quotation-watch", {
      job_id: "quotation_job_1",
      source: "openclaw_cron",
      request_key: "quotation-refresh:2026-06-15",
      run_label: "daily-market-refresh",
      wake_mode: "now",
      refresh_date: "2026-06-15",
    });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.watch.delivery_snapshot).toEqual({
      channel: "feishu",
      to: "user:ou_market",
      accountId: "main",
      threadId: "thread-market-refresh",
    });

    const watch = await getAsyncWatch({ stateDir: tmpDir, jobId: "quotation_job_1" });
    expect(watch?.deliverySnapshot).toEqual({
      channel: "feishu",
      to: "user:ou_market",
      accountId: "main",
      threadId: "thread-market-refresh",
    });
  });
});
