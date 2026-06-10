import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createPatternStrategyTools } from "./src/tools.js";
import { createPatternStrategyAsyncWatchService } from "./src/async-watch-service.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) => createPatternStrategyTools(api, ctx) as AnyAgentTool[]) as OpenClawPluginToolFactory,
    { optional: true },
  );
  api.registerService(createPatternStrategyAsyncWatchService(api));
}
