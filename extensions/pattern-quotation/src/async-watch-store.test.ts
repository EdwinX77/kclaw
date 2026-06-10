import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAsyncWatch,
  listAsyncWatches,
  removeAsyncWatch,
  upsertAsyncWatch,
} from "./async-watch-store.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pattern-quotation-watch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("pattern quotation async watch store", () => {
  it("upserts, retrieves, lists, and removes quotation watches", async () => {
    const stateDir = await makeTempStateDir();
    await upsertAsyncWatch({
      stateDir,
      watch: {
        kind: "quotation_refresh",
        jobId: "quote_job_1",
        sessionKey: "agent:tas-dispatch:main",
        agentId: "tas-dispatch",
        wakeMode: "now",
        followupMode: "heartbeat-system-event",
        source: "feishu_manual",
        refreshDate: "2026-04-30",
        registeredAt: 1,
        updatedAt: 1,
      },
    });

    const got = await getAsyncWatch({ stateDir, jobId: "quote_job_1" });
    expect(got?.kind).toBe("quotation_refresh");
    expect(got?.jobId).toBe("quote_job_1");

    const listed = await listAsyncWatches(stateDir);
    expect(listed).toHaveLength(1);

    const removed = await removeAsyncWatch({ stateDir, jobId: "quote_job_1" });
    expect(removed).toBe(true);
    expect(await getAsyncWatch({ stateDir, jobId: "quote_job_1" })).toBeNull();
  });
});
