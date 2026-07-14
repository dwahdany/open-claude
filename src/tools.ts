// Claude Code tool name/input → opencode tool rendering contract.
// Contract: docs/contract/05-data-model.md §6.3-6.5. The TUI special-cases these names
// (routes/session/index.tsx): bash, glob, read, grep, webfetch, websearch, write, edit,
// task, apply_patch, todowrite, question, skill, execute. Anything else → GenericTool.

const NAME_MAP: Record<string, string> = {
  Bash: "bash",
  BashOutput: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  Read: "read",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
  TodoWrite: "todowrite",
  Task: "task",
  Agent: "task",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  AskUserQuestion: "question",
  ExitPlanMode: "plan_exit",
  EnterPlanMode: "plan_enter",
  Skill: "skill",
}

export function mapToolName(name: string): string {
  if (NAME_MAP[name]) return NAME_MAP[name]
  // mcp__server__tool and unknown tools: lowercase reads nicer under GenericTool.
  return name
}

/** Translate Claude Code snake_case input keys to opencode's camelCase where the TUI reads them. */
export function mapToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const mapped = mapToolName(name)
  const out = { ...input }
  const rename = (from: string, to: string) => {
    if (from in out) {
      out[to] = out[from]
      delete out[from]
    }
  }
  switch (mapped) {
    case "edit":
    case "read":
    case "write":
      rename("file_path", "filePath")
      rename("replace_all", "replaceAll")
      break
    case "task":
      // description/subagent_type already match what the TUI reads.
      break
  }
  return out
}

/** A short human title for a running/completed tool, shown in spinner + block headers. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const mapped = mapToolName(name)
  switch (mapped) {
    case "bash":
      return String(input.command ?? "").slice(0, 80) || "bash"
    case "read":
    case "edit":
    case "write":
      return String(input.filePath ?? input.file_path ?? "")
    case "glob":
    case "grep":
      return String(input.pattern ?? "")
    case "webfetch":
      return String(input.url ?? "")
    case "websearch":
      return String(input.query ?? "")
    case "task":
      return String(input.description ?? "task")
    default:
      return mapped
  }
}

/** Build the state.metadata object the TUI's per-tool renderer reads from tool output. */
export function toolMetadata(name: string, input: Record<string, unknown>, output: string, structured: unknown): Record<string, unknown> {
  const mapped = mapToolName(name)
  const meta: Record<string, unknown> = {}
  const s = (structured ?? {}) as Record<string, unknown>
  switch (mapped) {
    case "bash":
      meta.output = output
      if (typeof s.exit === "number") meta.exit = s.exit
      break
    case "todowrite":
      meta.todos = input.todos
      break
    case "glob":
      if (typeof s.count === "number") meta.count = s.count
      break
    case "grep":
      if (typeof s.matches === "number") meta.matches = s.matches
      break
  }
  return meta
}

/** Flatten a tool_result content (string | blocks) into a display string. */
export function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === "object" && "type" in b) {
          const block = b as Record<string, unknown>
          if (block.type === "text") return String(block.text ?? "")
          if (block.type === "image") return "[image]"
        }
        return ""
      })
      .join("")
  }
  return ""
}
