import react from "@vitejs/plugin-react";
import dotenvFlow from "dotenv-flow";
import { defineConfig } from "electron-vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// The CLI's tsup.config.ts injects two things at build time: __CLI_VERSION__
// and the .env.production / .env.development values (as process.env.KEY
// replacements). Shared modules from ../src (version.ts, the API domain and
// WorkOS config in dustClient.ts / authService.ts) rely on both, so the main
// bundle has to provide the same ones. They come from the repo root's files,
// not a copy, so the CLI and the desktop app can't drift.
const repoRoot = resolve(__dirname, "..");
const cliPkg = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf-8")
) as { version: string };

// Unlike the CLI (build:dev reads .env.development, which points at a local
// Dust server), the desktop app talks to the real Dust in dev too, so UI work
// does not need a local backend. DUSTM_DESKTOP_ENV=development opts back in.
function cliDefines(): Record<string, string> {
  const nodeEnv =
    process.env["DUSTM_DESKTOP_ENV"] === "development" ? "development" : "production";
  const { parsed } = dotenvFlow.config({ node_env: nodeEnv, path: repoRoot });
  const defines: Record<string, string> = {
    __CLI_VERSION__: JSON.stringify(cliPkg.version),
  };
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (key === "NODE_ENV") {
      continue;
    }
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

// Strict in the packaged app. The dev server needs inline script (React
// refresh) and a websocket, so serve mode gets a looser policy; the build
// never does.
const CSP_STRICT = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const CSP_DEV = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "media-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "base-uri 'none'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "dustm-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        return html.replace(
          "%CSP%",
          ctx.server ? CSP_DEV : CSP_STRICT
        );
      },
    },
  };
}

export default defineConfig(() => ({
  main: {
    define: cliDefines(),
    build: {
      // keytar is the one native module; it stays external and is loaded
      // from desktop/node_modules (see package.json "dependencies"). Every
      // other dependency, including everything under ../src, is bundled.
      externalizeDeps: true,
      // Sounds must stay real files: the CSP allows media from self only, not data:.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      // Sounds must stay real files: the CSP allows media from self only, not data:.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), cspPlugin()],
    build: {
      // Sounds must stay real files: the CSP allows media from self only, not data:.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
}));
