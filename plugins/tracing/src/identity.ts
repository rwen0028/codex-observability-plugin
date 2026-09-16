import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { IdGenerator } from "@opentelemetry/sdk-trace-base";

type ObservationIds = { spanId: string; traceId?: string };
const observationIds = new AsyncLocalStorage<ObservationIds>();

// Keep this identity namespace independent of plugin releases and pricing.
// Langfuse scopes observation IDs by project. Do not include credentials,
// mutable output, or upload attempts in identities.
function digest(kind: string, parts: (string | number)[], length: number): string {
  const value = createHash("sha256")
    .update(JSON.stringify(["cctrace-identity-v1", kind, ...parts]))
    .digest("hex")
    .slice(0, length);
  return /^0+$/.test(value) ? "0".repeat(length - 1) + "1" : value;
}

export const stableTraceId = (...parts: (string | number)[]): string => digest("trace", parts, 32);
export const stableSpanId = (...parts: (string | number)[]): string => digest("span", parts, 16);

/** Apply IDs only while synchronously starting this observation. */
export function withObservationIds<T>(ids: ObservationIds, start: () => T): T {
  return observationIds.run(ids, start);
}

/** Uses the SDK's ID-generator extension point, without inventing a parent span. */
export class ObservationIdGenerator implements IdGenerator {
  generateTraceId(): string {
    return observationIds.getStore()?.traceId ?? randomBytes(16).toString("hex");
  }

  generateSpanId(): string {
    return observationIds.getStore()?.spanId ?? randomBytes(8).toString("hex");
  }
}
