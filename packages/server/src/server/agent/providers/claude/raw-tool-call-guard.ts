const RAW_TOOL_CALL_MARKER = '<invoke name="';
const RAW_TOOL_CALL_NAME_PATTERN = /<invoke\s+name="([^"]+)">/g;

export type ClaudeToolCallProtocolObservation =
  | { kind: "none" }
  | { kind: "recovered" }
  | { kind: "retryable"; reason: string }
  | { kind: "fatal"; reason: string };

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawToolNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(RAW_TOOL_CALL_NAME_PATTERN)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

function sameToolNameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((name, index) => name === sortedRight[index]);
}

export function observeClaudeToolCallProtocol(message: unknown): ClaudeToolCallProtocolObservation {
  const outer = toRecord(message);
  if (outer?.type !== "assistant") return { kind: "none" };
  const container = toRecord(outer.message);
  const content = container?.content;
  if (!Array.isArray(content)) return { kind: "none" };

  const rawNames: string[] = [];
  const structuredNames: string[] = [];
  for (const value of content) {
    const block = toRecord(value);
    if (block?.type === "text" && typeof block.text === "string") {
      rawNames.push(...rawToolNames(block.text));
    }
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name.trim()) {
      structuredNames.push(block.name.trim());
    }
  }

  if (rawNames.length > 0) {
    if (structuredNames.length === 0) {
      return {
        kind: "retryable",
        reason: "raw tool-call markup had no structured tool_use block",
      };
    }
    if (!sameToolNameMultiset(rawNames, structuredNames)) {
      return { kind: "fatal", reason: "raw and structured tool names disagree" };
    }
    return { kind: "recovered" };
  }

  if (container?.stop_reason === "tool_use" && structuredNames.length === 0) {
    return {
      kind: "retryable",
      reason: "stop_reason=tool_use had no structured tool_use block",
    };
  }
  if (structuredNames.length > 0) {
    return { kind: "recovered" };
  }
  return { kind: "none" };
}

export function visibleClaudeAssistantTextEnd(text: string, stopped: boolean): number {
  const markerIndex = text.indexOf(RAW_TOOL_CALL_MARKER);
  if (markerIndex >= 0) return markerIndex;
  if (stopped) return text.length;

  const maxLength = Math.min(text.length, RAW_TOOL_CALL_MARKER.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(RAW_TOOL_CALL_MARKER.slice(0, length))) {
      return text.length - length;
    }
  }
  return text.length;
}

export function readClaudeSyntheticApiError(message: unknown): string | null {
  const outer = toRecord(message);
  if (outer?.type !== "assistant") return null;
  const container = toRecord(outer.message);
  if (container?.model !== "<synthetic>") return null;
  const usage = toRecord(container.usage);
  if (usage?.output_tokens !== 0) return null;
  if (!Array.isArray(container.content)) return null;

  const text = container.content
    .map((value) => toRecord(value))
    .filter(
      (block): block is Record<string, unknown> =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("")
    .trim();
  return text.startsWith("API Error:") ? text : null;
}
