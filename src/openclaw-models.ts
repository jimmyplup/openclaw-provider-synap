// Synap catalog rows -> OpenClaw model definitions (models.providers.synap.models[]).
// Prices are copied from the live /v1/models answer at catalog time; OpenClaw's
// cost fields are USD per million tokens, the same unit Synap publishes.
import { ROUTER_MODEL_ID, type SynapModel } from "./core/models.ts";

/** Context window assumed when the catalog does not publish one (routers, brokered models). */
export const FALLBACK_CONTEXT_WINDOW = 65_536;
/** Output cap OpenClaw requests by default; also bounds an x402 quote, which prices max_tokens up front. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export interface OpenClawModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface OpenClawProviderConfig {
  baseUrl: string;
  api: "openai-completions";
  apiKey?: string;
  timeoutSeconds?: number;
  models: OpenClawModelDefinition[];
}

function label(m: SynapModel): string {
  if (m.id === ROUTER_MODEL_ID) return "Synap router (picks the cheapest model that can do the job)";
  if (m.router) return `${m.name} (router)`;
  return m.description && m.description !== m.name ? `${m.name} - ${m.description}` : m.name;
}

export function toOpenClawModel(m: SynapModel): OpenClawModelDefinition {
  return {
    id: m.id,
    name: label(m),
    reasoning: false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.pricing?.inputPerMillion ?? 0,
      output: m.pricing?.outputPerMillion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: Math.min(m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
  };
}

export function toOpenClawModels(models: SynapModel[]): OpenClawModelDefinition[] {
  return models.map(toOpenClawModel);
}

/** A row for an id the catalog has not listed yet (OpenClaw's resolveDynamicModel). */
export function dynamicModelRow(id: string): OpenClawModelDefinition {
  return toOpenClawModel({ id, name: id, description: "", router: false, vision: /(^|[-/])vl([-/]|$)|vision/i.test(id) });
}
