// Ambient type for the one host SDK subpath this plugin imports. OpenClaw
// ships this subpath without a .d.ts; the host links `openclaw` into the
// plugin's node_modules at install time (peer dependency), so nothing from
// OpenClaw is bundled here. The shape mirrors OpenClaw 2026.9.x.
declare module "openclaw/plugin-sdk/provider-entry" {
  export function defineSingleProviderPluginEntry(options: {
    id: string;
    name: string;
    description: string;
    configSchema?: unknown;
    provider?: unknown;
    register?: (api: never) => void;
  }): {
    id: string;
    name: string;
    description: string;
    register: (api: unknown) => void;
  };
}
