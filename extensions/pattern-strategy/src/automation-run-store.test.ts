import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLatestAutomationRun,
  listAutomationRuns,
  recordAutomationRun,
  resolveAutomationRunMemoryPath,
} from "./automation-run-store.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-automation-runs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("automation run store", () => {
  it("records runs to jsonl and mirrors markdown memory", async () => {
    const stateDir = await makeTempDir();
    const workspaceDir = await makeTempDir();

    const record = await recordAutomationRun({
      stateDir,
      workspaceDir,
      record: {
        runTime: "2026-04-30 15:20 Asia/Shanghai",
        category: "strategy",
        taskFamily: "mid_term_accel",
        taskKey: "strategy.mid_term_accel.daily_scan",
        cronJobId: "cron_mid_term",
        businessJobId: "claw_123",
        status: "succeeded",
        rawCount: 64,
        returnedCount: 1,
        symbols: ["300054.SZ", "300054.SZ"],
        overrides: { selection: { limit: 7000 } },
        notes: "signal_delivery returned one signal",
      },
    });

    expect(record.businessJobId).toBe("claw_123");
    expect(record.symbols).toEqual(["300054.SZ"]);

    const records = await listAutomationRuns({ stateDir });
    expect(records).toHaveLength(1);
    expect(records[0]?.taskFamily).toBe("mid_term_accel");

    const memoryPath = path.join(workspaceDir, "memory", "automation-runs.md");
    const markdown = await fs.readFile(memoryPath, "utf-8");
    expect(markdown).toContain("# Automation Runs");
    expect(markdown).toContain("claw_123");
    expect(markdown).toContain("300054.SZ");
  });

  it("filters latest records by task family", async () => {
    const stateDir = await makeTempDir();

    await recordAutomationRun({
      stateDir,
      record: {
        category: "strategy",
        taskFamily: "other_strategy",
        taskKey: "strategy.other.daily_scan",
        status: "succeeded",
        businessJobId: "claw_old",
      },
    });
    await recordAutomationRun({
      stateDir,
      record: {
        category: "strategy",
        taskFamily: "mid_term_accel",
        taskKey: "strategy.mid_term_accel.daily_scan",
        status: "failed",
        businessJobId: "claw_latest",
      },
    });

    const latest = await getLatestAutomationRun({
      stateDir,
      filter: { taskFamily: "mid_term_accel" },
    });

    expect(latest?.businessJobId).toBe("claw_latest");
  });

  it("rejects memory paths outside the workspace", async () => {
    const workspaceDir = await makeTempDir();

    expect(() =>
      resolveAutomationRunMemoryPath({
        workspaceDir,
        relPath: "../outside.md",
      }),
    ).toThrow(/escapes workspace/);
  });
});
