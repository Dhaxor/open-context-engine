export type ChatMode = "agent" | "search";
export type ToolStatus = "running" | "complete" | "error";
export type EditStatus = "applied" | "undone";

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "query"; text: string; mode: ChatMode; multi: boolean }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "newSession" }
  | { type: "getConfig" }
  | { type: "openSettings"; section?: "account" }
  | { type: "listHistory" }
  | { type: "deleteHistory"; id: string }
  | { type: "loadHistory"; id: string }
  | { type: "copyText"; text: string }
  | { type: "insertCode"; code: string }
  | { type: "applyCode"; code: string; file: string }
  | { type: "openDiff"; id: string }
  | { type: "undoEdit"; id: string }
  | { type: "redoEdit"; id: string }
  | { type: "undoEdits"; ids: string[] }
  | { type: "openFile"; path: string; line?: number }
  | { type: "pickContextFile" }
  | { type: "tour:complete" }
  | { type: "tour:skip" }
  | { type: "setEmbeddingApiKey"; value: string }
  | { type: "setLLMApiKey"; provider?: string; value: string }
  | { type: "setWebSearchApiKey"; value: string }
  | { type: "setModel"; provider: string; model: string; baseUrl?: string };

export type HostToWebviewMessage =
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "error"; text: string }
  | { type: "tool_update"; id: string; name: string; status: ToolStatus; label: string; summary?: string; args?: Record<string, unknown> }
  | { type: "task_plan"; plan: string[] }
  | { type: "agent_step"; step: number; status: "running" | "complete" }
  | { type: "edit"; edit: any }
  | { type: "edit_status"; id: string; status: EditStatus }
  | { type: "edit_summary"; ids: string[] }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  | { type: "model_routed"; tier: { name: string; provider: string; model: string } }
  | { type: "compaction"; dropped: number }
  | { type: "addUserMessage"; text: string }
  | { type: "model"; provider: string; model: string }
  | { type: "license"; status: any }
  | { type: "context"; activeFile?: string; hasSelection?: boolean }
  | { type: "sources"; files: { path: string; lines?: string }[] }
  | { type: "insertMention"; path: string }
  | { type: "config"; [key: string]: unknown }
  | { type: "search_start" }
  | { type: "search_result"; results: any[] }
  | { type: "history_list"; sessions: any[]; currentId: string }
  | { type: "history_load"; session: any }
  | { type: "clear" }
  | { type: "tour:start"; force?: boolean };
