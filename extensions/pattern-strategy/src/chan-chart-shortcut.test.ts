import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
} from "../../../src/plugins/hooks.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import {
  handleChanChartBeforeDispatch,
  resolveChanChartShortcutRequest,
} from "./chan-chart-shortcut.js";

function createApi(): OpenClawPluginApi {
  return {
    pluginConfig: {
      baseUrl: "http://pattern-strategy.local",
      chartBaseUrl: "http://charts.pattern-strategy.local",
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

describe("Pattern Strategy Chan chart shortcut", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses year-to-date Chan chart requests", () => {
    expect(
      resolveChanChartShortcutRequest(
        "请给我下东方电气今年以来的chan图",
        new Date("2026-06-12T04:55:00.000Z"),
      ),
    ).toEqual({
      securityName: "东方电气",
      startDate: "2026-01-01",
      endDate: "2026-06-12",
    });
    expect(
      resolveChanChartShortcutRequest(
        "请给我下600875今年以来的chan图",
        new Date("2026-06-12T04:55:00.000Z"),
      ),
    ).toMatchObject({
      symbol: "600875",
      startDate: "2026-01-01",
      endDate: "2026-06-12",
    });
    expect(
      resolveChanChartShortcutRequest(
        "请给我下今年以来凤凰航运的chan图",
        new Date("2026-06-12T04:55:00.000Z"),
      ),
    ).toEqual({
      securityName: "凤凰航运",
      startDate: "2026-01-01",
      endDate: "2026-06-12",
    });
    expect(resolveChanChartShortcutRequest("东方电气走势怎么看")).toBeUndefined();
  });

  it("handles clear Chan chart requests before model dispatch", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            tool_name: "chan.generate_chart",
            data: {
              symbol: "600875.SH",
              security_name: "东方电气",
              chart_url: "/api/strategies/chart?path=charts/600875.png",
              chart_path: "charts/600875.png",
              signals_detected: 2,
              current_price: { date: "2026-06-12", close: 15.2 },
              latest_box: {
                start_date: "2026-04-10",
                end_date: "2026-06-03",
                bottom: 14.5,
                top: 16.5,
              },
              recent_high: { date: "2026-02-14", value: 19.05 },
              recent_low: { date: "2026-05-27", value: 14.16 },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("png"), {
          headers: {
            "content-type": "image/png",
          },
        }),
      );
    const api = createApi();
    const event = {
      content: "请给我下东方电气今年以来的chan图",
      channel: "feishu",
      sessionKey: "agent:tas-dispatch:feishu:direct:ou_user",
    } as PluginHookBeforeDispatchEvent;
    const ctx = { channelId: "feishu" } as PluginHookBeforeDispatchContext;

    const result = await handleChanChartBeforeDispatch(api, event, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://pattern-strategy.local/tools/chan.generate_chart/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: {
            security_name: "东方电气",
            start_date: "2026-01-01",
            end_date: "2026-06-12",
            use_price_cache: true,
          },
          context: {
            source: "openclaw_agent",
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://charts.pattern-strategy.local/api/strategies/chart?path=charts/600875.png",
      expect.any(Object),
    );
    expect(result).toMatchObject({
      handled: true,
      reply: {
        text: expect.stringContaining("东方电气（600875.SH） 今年以来 Chan 走势图已生成。"),
        mediaUrl: expect.stringContaining("600875.png"),
        mediaUrls: [expect.stringContaining("600875.png")],
        trustedLocalMedia: true,
        channelData: { feishu: { mediaFirst: true } },
      },
    });
    expect(result?.reply?.text).toContain("图解摘要：");
    expect(result?.reply?.text).toContain("最后一个箱体约 14.5-16.5 元");
    expect(result?.reply?.text).toContain("最近顶分型 19.05（2026-02-14）");
    expect(result?.reply?.text).toContain("最近底分型 14.16（2026-05-27）");
    expect(result?.reply?.text).toContain("最新收盘约 15.2 元");
    expect(result?.reply?.text).toContain("本次检测到 2 个结构信号");
  });

  it("falls through when the remote chart request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "not_found",
            message: "unknown symbol",
          },
        }),
      ),
    );
    const api = createApi();

    await expect(
      handleChanChartBeforeDispatch(
        api,
        {
          content: "请给我下不存在科技今年以来的chan图",
          channel: "feishu",
        } as PluginHookBeforeDispatchEvent,
        { channelId: "feishu" } as PluginHookBeforeDispatchContext,
      ),
    ).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to agent dispatch"),
    );
  });
});
