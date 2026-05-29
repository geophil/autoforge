import type { ModelContentBlock, ModelMessage } from "./model-provider";

export interface CompactableHistorySlice {
  messages: ModelMessage[];
  droppedTurns: number;
  retainedRecentTurns: number;
}

export class ConversationHistory {
  private readonly messages: ModelMessage[];

  constructor(initialPrompt: string) {
    this.messages = [{ role: "user", content: [{ type: "text", text: initialPrompt }] }];
  }

  appendAssistant(content: ModelContentBlock[]): void {
    this.messages.push({ role: "assistant", content: snapshotContent(content) });
  }

  appendToolResults(content: ModelContentBlock[]): void {
    this.messages.push({ role: "user", content: snapshotContent(content) });
  }

  snapshot(): ModelMessage[] {
    return snapshotMessages(this.messages);
  }

  serializedChars(): number {
    return JSON.stringify(this.messages).length;
  }

  compactableSlice(retainRecentMessages: number): CompactableHistorySlice | null {
    const groups = groupedMessages(this.messages.slice(1));
    if (groups.length <= 1) return null;

    let retainedCount = 0;
    let retainFromGroup = groups.length;
    for (let index = groups.length - 1; index >= 0; index--) {
      retainedCount += groups[index].length;
      retainFromGroup = index;
      if (retainedCount >= retainRecentMessages) break;
    }
    const compactedGroups = groups.slice(0, retainFromGroup);
    if (compactedGroups.length === 0) return null;
    const retainedGroups = groups.slice(retainFromGroup);
    return {
      messages: compactedGroups.flat(),
      droppedTurns: compactedGroups.flat().length,
      retainedRecentTurns: retainedGroups.flat().length
    };
  }

  replaceCompactableSlice(slice: CompactableHistorySlice, compactMemory: string): void {
    const first = this.messages[0];
    const retained = this.messages.slice(1).slice(slice.droppedTurns);
    this.messages.length = 0;
    this.messages.push({
      role: "user",
      content: [
        ...snapshotContent(first.content),
        { type: "text", text: compactMemory }
      ]
    });
    this.messages.push(...snapshotMessages(retained));
  }
}

function groupedMessages(messages: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const current = messages[index];
    const next = messages[index + 1];
    if (current.role === "assistant" && hasToolUse(current) && next?.role === "user" && hasToolResult(next)) {
      groups.push([current, next]);
      index += 1;
    } else {
      groups.push([current]);
    }
  }
  return groups;
}

function hasToolUse(message: ModelMessage): boolean {
  return message.content.some((block) => block.type === "tool_use");
}

function hasToolResult(message: ModelMessage): boolean {
  return message.content.some((block) => block.type === "tool_result");
}

function snapshotMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: snapshotContent(message.content)
  }));
}

function snapshotContent(content: ModelContentBlock[]): ModelContentBlock[] {
  return content.map((block) => {
    try {
      return structuredClone(block) as ModelContentBlock;
    } catch {
      return JSON.parse(JSON.stringify(block)) as ModelContentBlock;
    }
  });
}
