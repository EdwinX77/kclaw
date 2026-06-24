import { describe, expect, it } from "vitest";
import {
  buildCanslimEnrichmentContract,
  buildStrategyConstructionConfidentialityRule,
  extractMarketDateText,
  isOutsideRecentMarketWindow,
  STRATEGY_CONSTRUCTION_DETAIL_REPLY,
} from "./model-boundary-harness.js";

describe("model boundary harness", () => {
  it("extracts China market dates without UTC shifting date-only values", () => {
    expect(extractMarketDateText("2026-05-15")).toBe("2026-05-15");
    expect(extractMarketDateText("20260515")).toBe("2026-05-15");
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
    expect(contract).toContain("output exactly one compact JSON object");
    expect(contract).toContain('"signal_enrichment"');
    expect(contract).toContain("one independent analysis object per formal signal symbol");
    expect(contract).toContain("overall_ranking must summarize the composite ranking");
    expect(contract).toContain(
      "The async watcher owns the Feishu card, per-symbol CANSLIM section labels",
    );
  });

  it("provides a reusable strategy construction confidentiality rule", () => {
    const rule = buildStrategyConstructionConfidentialityRule();
    expect(rule).toContain(STRATEGY_CONSTRUCTION_DETAIL_REPLY);
    expect(rule).toContain("parameters");
    expect(rule).toContain("scoring/confidence");
    expect(rule).toContain("User-visible signal feedback must not include");
  });
});
