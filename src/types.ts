// Minimal opencode wire types the shim produces. These mirror the v1 schema shapes the
// TUI actually reads (docs/contract/05-data-model.md). Only fields the TUI dereferences
// are typed strictly; the rest are permissive.

export interface Tokens {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

export interface Session {
  id: string
  slug: string
  projectID: string
  directory: string
  path?: string // cwd relative to the worktree (05-data-model.md §2.1); set by /move, filtered by GET /session
  title: string
  version: string
  parentID?: string
  cost?: number
  tokens?: Tokens
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  time: { created: number; updated: number; compacting?: number }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: { name: string; data: Record<string, unknown> }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  cost: number
  tokens: Tokens
  variant?: string
  finish?: string
}

export type Message = UserMessage | AssistantMessage

export type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
    }
  | { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } }

interface PartBase {
  id: string
  sessionID: string
  messageID: string
}

export type Part =
  | (PartBase & { type: "text"; text: string; synthetic?: boolean; time?: { start: number; end?: number }; metadata?: Record<string, unknown> })
  | (PartBase & { type: "reasoning"; text: string; time: { start: number; end?: number }; metadata?: Record<string, unknown> })
  | (PartBase & { type: "tool"; callID: string; tool: string; state: ToolState; metadata?: Record<string, unknown> })
  | (PartBase & { type: "step-start"; snapshot?: string })
  | (PartBase & { type: "step-finish"; reason: string; cost: number; tokens: Tokens })
  | (PartBase & { type: "compaction"; auto: boolean; overflow?: boolean })

export interface WithParts {
  info: Message
  parts: Part[]
}

export interface Todo {
  content: string
  status: string
  priority: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

// question.asked payload (vendor schema/src/v1/question.ts). answers on reply are
// Array<Array<string>>: one array per question, each entry a selected option label
// (or one raw custom-typed string).
export interface QuestionInfo {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}
