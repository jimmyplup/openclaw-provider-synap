// OpenClaw plugin entry (package.json "openclaw.extensions").
// Uses the host's documented single-provider helper so API-key onboarding
// (`openclaw onboard --synap-api-key ...`, `openclaw models auth login --provider synap`)
// and the model picker work like any built-in provider.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { configSchema } from "./config-schema.ts";
import { createSynapProvider, registerSynapServices, type PluginApiLike } from "./provider.ts";
import { PLUGIN_ID } from "./settings.ts";

export default defineSingleProviderPluginEntry({
  id: PLUGIN_ID,
  name: "Synap by Linkrra",
  description:
    "Synap by Linkrra as an OpenClaw model provider: open models on dedicated GPUs behind an OpenAI-compatible API. Pay with an API key, or per call in USDC over x402 (Base or Solana) through a local proxy.",
  configSchema,
  provider: (api: PluginApiLike) => createSynapProvider(api),
  register: (api: PluginApiLike) => registerSynapServices(api),
});
