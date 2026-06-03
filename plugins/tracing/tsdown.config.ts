import { defineConfig } from "tsdown";

// Paths are resolved relative to this config file's directory (plugins/tracing).
//
// The plugin runs as a standalone Codex hook (`node dist/index.mjs`) without an
// install step, so the bundle must be fully self-contained. We bundle every
// runtime dependency (Langfuse SDK, OpenTelemetry, zod) and keep only Node.js
// built-ins external.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@langfuse\//, /^@opentelemetry\//, /^zod$/, /^zod\//],
  dts: false,
  clean: true,
  minify: false,
  // Emit a single self-contained file. OpenTelemetry's resource detection uses
  // dynamic imports (platform-specific machine-id helpers); inlining them keeps
  // the hook to one shippable `dist/index.mjs`.
  outputOptions: {
    inlineDynamicImports: true,
  },
});
