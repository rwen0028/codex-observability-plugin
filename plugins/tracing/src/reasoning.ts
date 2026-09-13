import type { ReasoningRecord, RolloutLine } from "./types.js";

export function reasoningRecord(line: RolloutLine): ReasoningRecord | undefined {
  const payload = line.payload as Record<string, unknown>;
  if (!payload || typeof payload !== "object") return undefined;
  const isAnalysis = payload.channel === "analysis";
  if (
    (line.type === "response_item" &&
      (payload.type === "reasoning" ||
        (payload.type === "message" && payload.role === "assistant" && isAnalysis))) ||
    (line.type === "event_msg" &&
      (payload.type === "agent_reasoning" ||
        payload.type === "agent_reasoning_raw_content" ||
        (payload.type === "agent_message" && isAnalysis)))
  ) {
    return { source: line.type, timestamp: line.timestamp, payload };
  }
  return undefined;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part: unknown) => {
    if (typeof part === "string") return part ? [part] : [];
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return part.text ? [part.text] : [];
    }
    return [];
  });
}

export function reasoningText(records: ReasoningRecord[]): string | undefined {
  const mirrors = new Map<string, number>();
  const seenItems = new Map<string, string>();
  const canonical = records.map((record) => {
    if (record.source !== "response_item") return undefined;
    const { payload } = record;
    const content = textParts(payload.content);
    const summary = textParts(payload.summary);
    const preferred = content.length > 0 ? content : summary;
    const text = preferred.join("\n");
    if (typeof payload.id === "string") {
      const key = JSON.stringify([payload.content, payload.summary]);
      if (seenItems.get(payload.id) === key) return "";
      seenItems.set(payload.id, key);
    }
    // Match mirrored events by occurrence within this step, not globally by text.
    for (const parts of [content, summary]) {
      for (const part of parts) mirrors.set(part, (mirrors.get(part) ?? 0) + 1);
      if (parts.length > 1) {
        const joined = parts.join("\n");
        mirrors.set(joined, (mirrors.get(joined) ?? 0) + 1);
      }
    }
    return text;
  });

  const texts = records.map((record, index) => {
    if (canonical[index] !== undefined) return canonical[index];
    const { payload } = record;
    const text = textParts(payload.text ?? payload.message ?? payload.content).join("\n");
    const count = mirrors.get(text) ?? 0;
    if (count > 0) {
      mirrors.set(text, count - 1);
      return "";
    }
    return text;
  });
  return texts.filter(Boolean).join("\n") || undefined;
}
