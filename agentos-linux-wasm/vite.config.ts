import path from "node:path";
import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
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
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        buffer: "buffer/",
        // Sync GrabButton + AllowEvents(ReplayPointer) needed by real Aurora WM.
        "x11/lib/xserver/input.js": path.resolve(projectRoot, "vendor/x11/input.js"),
        // Full COMPOSITE / XFIXES / SHAPE / DAMAGE / RANDR / GLX stack.
        "x11/lib/xserver/server.js": path.resolve(projectRoot, "vendor/x11/server.js"),
      },
    },
    optimizeDeps: {
      include: ["buffer"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: [
        "terminal.local",
        "tmp-finished-roles-resistant.trycloudflare.com",
        ".trycloudflare.com",
      ],
      watch: {
        // Firefox/Gecko rebuild trees are huge; watching them exhausts inotify.
        ignored: /(?:^|[\/\\])(?:\.git|node_modules|firefox-wasm|netsurf|\.sites-runtime|\.wrangler)(?:[\/\\]|$)/,
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
