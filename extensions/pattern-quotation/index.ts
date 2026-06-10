import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createPatternQuotationAsyncWatchService } from "./src/async-watch-service.js";
import { createPatternQuotationTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) => createPatternQuotationTools(api, ctx) as AnyAgentTool[]) as OpenClawPluginToolFactory,
    { optional: true },
  );
  api.registerService(createPatternQuotationAsyncWatchService(api));
}
