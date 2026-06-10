import { describe, expect, it } from "vitest";
import {
  buildCanslimEnrichmentContract,
  buildStrategyConstructionConfidentialityRule,
  extractMarketDateText,
  isFrontDoorAgentDirectExecution,
  isOutsideRecentMarketWindow,
  STRATEGY_CONSTRUCTION_DETAIL_REPLY,
  validateCanslimOutputShape,
} from "./model-boundary-harness.js";

describe("model boundary harness", () => {
  it("extracts China market dates without UTC shifting date-only values", () => {
    expect(extractMarketDateText("2026-05-15")).toBe("2026-05-15");
    expect(extractMarketDateText("2026-05-14T23:30:00-07:00")).toBe("2026-05-15");
  });

  it("checks recent windows by market date ordinal", () => {
    expect(
      isOutsideRecentMarketWindow({
        referenceDate: "2026-05-15",
        signalDate: "2026-05-13",
        recentDays: 5,
      }),
    ).toBe(false);
    expect(
      isOutsideRecentMarketWindow({
        referenceDate: "2026-05-15",
        signalDate: "2026-05-07",
        recentDays: 5,
      }),
    ).toBe(true);
  });

  it("provides a reusable CANSLIM output contract", () => {
    const contract = buildCanslimEnrichmentContract();
    expect(contract).toContain("Required skill: canslim-enrichment");
    expect(contract).toContain(STRATEGY_CONSTRUCTION_DETAIL_REPLY);
    expect(contract).toContain("factor_financial_growth");
    expect(contract).toContain("非 CANSLIM 舆情/热度");
  });

  it("provides a reusable strategy construction confidentiality rule", () => {
    const rule = buildStrategyConstructionConfidentialityRule();
    expect(rule).toContain(STRATEGY_CONSTRUCTION_DETAIL_REPLY);
    expect(rule).toContain("parameters");
    expect(rule).toContain("scoring/confidence");
    expect(rule).toContain("User-visible signal feedback must not include");
  });

  it("validates required enrichment sections", () => {
    expect(
      validateCanslimOutputShape(
        [
          "技术信号",
          "CANSLIM 补充",
          "非 CANSLIM 舆情/热度",
          "信息缺口",
          "交易原则检查",
          "说明",
        ].join("\n"),
      ).ok,
    ).toBe(true);
    expect(validateCanslimOutputShape("技术信号\n说明").missingSections).toContain("CANSLIM 补充");
  });

  it("blocks direct front-door strategy submission while allowing internal agents", () => {
    expect(
      isFrontDoorAgentDirectExecution({
        agentId: "tas-dispatch",
        sessionKey: "feishu:group:abc",
        toolName: "strategy_task_run",
      }),
    ).toBe(true);
    expect(
      isFrontDoorAgentDirectExecution({
        agentId: "pattern-strategy",
        sessionKey: "agent:pattern-strategy:main",
        toolName: "strategy_task_run",
      }),
    ).toBe(false);
  });
});
