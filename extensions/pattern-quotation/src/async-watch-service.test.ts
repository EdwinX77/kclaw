import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { __testing } from "./async-watch-service.js";
import { getAsyncWatch, upsertAsyncWatch } from "./async-watch-store.js";
import type { QuotationRefreshAsyncWatch } from "./async-watch-store.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pattern-quotation-watch-"));
  tempDirs.push(dir);
  return dir;
}

function createApi(stateDir: string): OpenClawPluginApi {
  return {
    config: {},
    pluginConfig: { baseUrl: "http://127.0.0.1:18080" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
    },
  } as unknown as OpenClawPluginApi;
}

function createWatch(): QuotationRefreshAsyncWatch {
  return {
    kind: "quotation_refresh",
    jobId: "quote_job_1",
    sessionKey: "agent:tas-dispatch:cron:market-refresh",
    agentId: "tas-dispatch",
    wakeMode: "now",
    followupMode: "heartbeat-system-event",
    source: "openclaw_cron",
    requestKey: "quotation:pre_market:20260615",
    runLabel: "daily-market-refresh",
    refreshDate: "2026-06-15",
    registeredAt: 1,
    updatedAt: 1,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Pattern Quotation async watch service", () => {
  it("marks completed quotation watches after a terminal status is observed", async () => {
    const stateDir = await makeTempStateDir();
    const watch = createWatch();
    await upsertAsyncWatch({ stateDir, watch });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            tool_name: "quotation.refresh_get",
            data: {
              job_id: watch.jobId,
              status: "completed",
              chain_key: "pre_market",
              stages: ["events", "prices", "financials"],
              start_date: "2026-06-15",
              end_date: "2026-06-15",
              stage: "done",
              progress: 1,
              failed_symbols: 0,
              event_row_count: 123,
            },
            meta: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await __testing.processQuotationWatch({
      api: createApi(stateDir),
      stateDir,
      watch,
    });

    const updated = await getAsyncWatch({ stateDir, jobId: watch.jobId });
    expect(updated).toMatchObject({
      lastRemoteStatus: "completed",
      deliveryStatus: "not-requested",
    });
    expect(updated?.lastError).toBeUndefined();
    expect(updated?.completedAt).toEqual(expect.any(Number));
  });

  it.each([
    {
      label: "date",
      identity: {
        chain_key: "pre_market",
        stages: ["events", "prices", "financials"],
        start_date: "2026-06-14",
        end_date: "2026-06-14",
      },
      expected: "end_date expected 2026-06-15, received 2026-06-14",
    },
    {
      label: "request key",
      identity: {
        chain_key: "post_open",
        stages: ["margin_trading"],
        start_date: "2026-06-15",
        end_date: "2026-06-15",
      },
      expected:
        "request_key expected quotation:pre_market:20260615, received quotation:post_open:20260615",
    },
  ])("rejects a terminal job with mismatched $label identity", async ({ identity, expected }) => {
    const stateDir = await makeTempStateDir();
    const watch = createWatch();
    await upsertAsyncWatch({ stateDir, watch });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              tool_name: "quotation.refresh_get",
              data: { job_id: watch.jobId, status: "completed", failed_symbols: 0, ...identity },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await __testing.processQuotationWatch({ api: createApi(stateDir), stateDir, watch });

    const updated = await getAsyncWatch({ stateDir, jobId: watch.jobId });
    expect(updated).toMatchObject({
      lastRemoteStatus: "identity_mismatch",
      deliveryStatus: "not-requested",
      lastError: expect.stringContaining(expected),
    });
    expect(updated?.completedAt).toEqual(expect.any(Number));
  });
});
