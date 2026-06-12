import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createPatternStrategyAsyncWatchService } from "./src/async-watch-service.js";
import { handleChanChartBeforeDispatch } from "./src/chan-chart-shortcut.js";
import { createPatternStrategyTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) => createPatternStrategyTools(api, ctx) as AnyAgentTool[]) as OpenClawPluginToolFactory,
    { optional: true },
  );
  api.registerService(createPatternStrategyAsyncWatchService(api));
  api.on("before_dispatch", (event, ctx) => handleChanChartBeforeDispatch(api, event, ctx), {
    timeoutMs: 20_000,
  });
}
