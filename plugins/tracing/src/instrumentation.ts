import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Config } from "./config.js";

export type Instrumentation = {
  flush: () => Promise<void>;
  /** Flush buffered spans and tear down the tracer provider. */
  shutdown: () => Promise<void>;
};

/**
 * Configure an isolated OpenTelemetry tracer provider wired to Langfuse.
 *
 * We register a dedicated `NodeTracerProvider` (rather than the full auto-
 * instrumenting `NodeSDK`) so the bundle stays small and free of dynamic
 * instrumentation loading. Registering the provider also installs the
 * AsyncLocalStorage context manager that `propagateAttributes` relies on.
 *
 * Spans are batched within each turn. The worker awaits a flush between turns
 * so full reasoning archives cannot accumulate across a large upload backlog.
 * `shutdown()` also flushes before the process exits.
 */
export function setupInstrumentation(config: Config): Instrumentation {
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    exportMode: "batched",
    // The hook only ever creates Langfuse spans, so export all of them.
    shouldExportSpan: () => true,
  });

  const provider = new NodeTracerProvider({
    spanProcessors: [spanProcessor],
  });
  provider.register();

  return {
    flush: () => spanProcessor.forceFlush(),
    shutdown: async () => {
      await spanProcessor.forceFlush();
      await provider.shutdown();
    },
  };
}
