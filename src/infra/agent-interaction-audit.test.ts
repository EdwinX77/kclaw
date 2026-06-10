import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAgentInteractionAuditRecord,
  resolveAgentInteractionAuditPath,
} from "./agent-interaction-audit.js";

const touchedDirs: string[] = [];

afterEach(async () => {
  for (const dir of touchedDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("agent interaction audit", () => {
  it("writes jsonl records under the state logs directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-audit-"));
    touchedDirs.push(root);
    process.env.OPENCLAW_STATE_DIR = root;
    const filePath = resolveAgentInteractionAuditPath(process.env);

    await appendAgentInteractionAuditRecord({
      kind: "subagent_spawn",
      requesterSessionKey: "agent:tas:main",
      childSessionKey: "agent:pattern-strategy:subagent:1",
      runId: "run-1",
      summary: "spawned child session",
    });

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.kind).toBe("subagent_spawn");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.requesterSessionKey).toBe("agent:tas:main");
  });
});
