import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;
const alphaVantageApiKey = process.env.ALPHA_VANTAGE_API_KEY?.trim();
const automationToken = process.env.NORTHSTAR_AUTOMATION_TOKEN?.trim();
const localVars: Record<string, string> = {};
if (alphaVantageApiKey) localVars.ALPHA_VANTAGE_API_KEY = alphaVantageApiKey;
if (automationToken) localVars.NORTHSTAR_AUTOMATION_TOKEN = automationToken;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// Runtime state changes continuously while the local scanner is running. If
// Vite watches those files, every quote/database write can trigger a full page
// reload before the client finishes hydrating, leaving the terminal on its
// loading screen. Source files remain watched normally.
const runtimeWatchIgnores = [
  "**/.wrangler/**",
  "**/backups/**",
  "**/outputs/**",
  "**/*.log",
  "**/*.sqlite",
  "**/*.sqlite-shm",
  "**/*.sqlite-wal",
  "**/tsconfig.tsbuildinfo",
  "**/public/data/terminal_snapshot.json",
];

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  vars: localVars,
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      watch: {
        ignored: runtimeWatchIgnores,
        ...(isCodexSeatbeltSandbox ? { useFsEvents: false, usePolling: true } : {}),
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
