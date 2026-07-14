# 07 — Claude Agent SDK surface & definitive SDK→opencode mapping

Scope: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` **0.3.207**) surface the shim consumes,
and the authoritative mapping from SDK messages/streams to the opencode HTTP/SSE contract that the
stock opencode TUI **v1.17.19** actually reads.

All claims cite source. Repo-relative paths:

- `SDK` = `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (6923 lines; types are authoritative for 0.3.207)
- `SDKTOOLS` = `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` (built-in tool input/output JSON shapes)
- `MJS` = `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (minified impl — cited by exact code snippet, not line)
- `BETA` = `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` (`@anthropic-ai/sdk` 0.111.0, peer dep)
- `OC` = `vendor/opencode/` (opencode v1.17.19 source)

> **Headline finding (drives the whole design):** the stock TUI transcript is rendered from the
> **classic v1 events** (`message.updated`, `message.part.updated`, `message.part.delta`,
> `session.status`, `session.updated`, `session.error`, permission/question events) handled in
> `OC packages/tui/src/context/sync.tsx:170-440`. The `session.next.*` v2 events are consumed only by
> `OC packages/tui/src/context/data.tsx:124-403`, and the only consumer of `useData()` is prompt
> autocomplete (`OC packages/tui/src/component/prompt/autocomplete.tsx`). Additionally `sync.tsx:294-308`
> consumes exactly one `session.next.*` event: `session.next.moved`. **The shim must emit the classic
> v1 events; session.next.* is optional polish.** Both schemas are documented below.

---

## 1. Package facts

`node_modules/@anthropic-ai/claude-agent-sdk/package.json`:

- `"version": "0.3.207"`, `"claudeCodeVersion": "2.1.207"` — the SDK bundles/spawns Claude Code CLI 2.1.207.
- `"main": "sdk.mjs"`, `"types": "sdk.d.ts"`; exports: `.` (main), `./extract` (bunfs binary extraction),
  `./browser`, `./bridge`, `./sdk-tools` (types only).
- Peer deps: `@anthropic-ai/sdk >= 0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`.
- Optional deps: per-platform native CLI binaries (`@anthropic-ai/claude-agent-sdk-darwin-arm64` etc.).
- README (`node_modules/@anthropic-ai/claude-agent-sdk/README.md`): when compiling with
  `bun build --compile`, `require.resolve` can't find the CLI binary inside `$bunfs`; embed the platform
  binary as a file asset, `extractFromBunfs(binPath)`, and pass `options.pathToClaudeCodeExecutable`.
  **This applies to us: open-claude is a Bun app.** (Only needed for compiled binaries — plain `bun run`
  resolves normally.)

The SDK spawns the CLI as a subprocess and speaks NDJSON over stdio:
`["--output-format","stream-json","--verbose","--input-format","stream-json"]` (MJS, exact snippet:
`"--output-format","stream-json","--verbose","--input-format","stream-json"]`). Other flags observed being
passed from `Options`: `--setting-sources=…`, `--strict-mcp-config`, `--permission-mode`, `--mcp-config`,
`--model`, `--fallback-model`, `--max-turns`, `--resume`, `--continue`, `--fork-session`, `--session-id`,
`--include-partial-messages` (all in MJS arg assembly).

---

## 2. `query()` — entry point (SDK:2527-2530)

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

**Streaming-input mode** (the mode we must use): pass an `AsyncIterable<SDKUserMessage>` as `prompt`.
Only in this mode are the `Query` control methods usable — "The following methods are control requests,
and are only supported when streaming input/output is used" (SDK:2231-2235). The iterable stays open for
the process lifetime; push new user messages into it per TUI prompt. There is also
`Query.streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>` (SDK:2492-2497) for injecting
an additional stream.

`SDKUserMessage` — what you push in (SDK:4439-4482, verbatim, comment-stripped):

```ts
export declare type SDKUserMessage = {
    type: 'user';
    message: MessageParam;               // Anthropic API MessageParam: { role: 'user', content: string | ContentBlockParam[] }
    parent_tool_use_id: string | null;
    isSynthetic?: boolean;
    tool_use_result?: unknown;           // structured tool Output (per-tool shape, see §8.5)
    priority?: 'now' | 'next' | 'later';
    origin?: SDKMessageOrigin;
    shouldQuery?: boolean;               // false => appended to transcript without triggering a turn
    timestamp?: string;                  // ISO; older emitters omit
    uuid?: UUID;                         // optional on input
    session_id?: string;                 // optional on input
    subagent_type?: string;
    task_description?: string;
};
```

Minimal prompt push:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null,"session_id":"<sid>"}
```

`UUID` is Node's `crypto` template-literal UUID type (SDK:11 `import type { UUID } from 'crypto'`) —
i.e. a real `xxxxxxxx-xxxx-…` string.

Pre-warming: `startup({options, initializeTimeoutMs}): Promise<WarmQuery>` (SDK:6562-6565);
`WarmQuery.query(prompt)` can be called once, `WarmQuery.close()` discards (SDK:6892-6903). Useful to
hide first-turn spawn latency behind the TUI's bootstrap.

---

## 3. `Options` — fields we need (SDK:1282-2014)

Verbatim types with defaults verified against the implementation where the docs are ambiguous.

| Field | Type (verbatim) | Notes / verified behavior |
|---|---|---|
| `abortController` | `AbortController` (SDK:1287) | Aborting stops the query and cleans up. Graceful path: stdin EOF → ~2s grace → kill (SpawnOptions.signal doc SDK:6533-6555). |
| `cwd` | `string` (SDK:1349) | Defaults to `process.cwd()`. One `query()` = one cwd; the TUI's project directory must be passed here. |
| `model` | `string` (SDK:1673) | "Defaults to the CLI default model. Examples: 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'". |
| `fallbackModel` | `string` (SDK:1435) | Comma-separated list allowed; primary retried at each user turn. |
| `maxTurns` | `number` (SDK:1638) | Exceeding yields `SDKResultError` subtype `error_max_turns`. |
| `maxBudgetUsd` | `number` (SDK:1643) | → `error_max_budget_usd` result. |
| `includePartialMessages` | `boolean` (SDK:1591) | **Required for streaming**: emits `SDKPartialAssistantMessage` (`type:'stream_event'`). |
| `forwardSubagentText` | `boolean` (SDK:1598) | By default only tool_use/tool_result blocks from subagents are forwarded; `true` forwards full subagent text/thinking as messages with `parent_tool_use_id` set. **Set `true`** to render nested subagent transcripts (§10.9). |
| `canUseTool` | `CanUseTool` (SDK:1340) | §4. Cannot be combined with `permissionPromptToolName` (MJS: `Error("canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.")`). |
| `permissionMode` | `PermissionMode` (SDK:1699) | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` (SDK:2043). `bypassPermissions` additionally requires `allowDangerouslySkipPermissions: true` (SDK:1711). |
| `resume` | `string` (SDK:1763) | Session UUID to resume. Mutually exclusive with `continue`. |
| `forkSession` | `boolean` (SDK:1460) | With `resume`: fork to a new session ID instead of continuing. |
| `continue` | `boolean` (SDK:1345) | Resume most recent conversation in cwd. |
| `sessionId` | `string` (SDK:1769) | Force a specific (valid UUID) session id for a NEW session. |
| `resumeSessionAt` | `string` (SDK:1775) | Resume only up to a given message UUID (from `SDKAssistantMessage.uuid`). |
| `systemPrompt` | `string \| string[] \| { type:'preset'; preset:'claude_code'; append?: string; excludeDynamicSections?: boolean }` (SDK:1977-1982) | **Default when omitted: EMPTY custom system prompt** — verified in MJS: `if(i===void 0)p="";else if(typeof i==="string")p=i;else if(Array.isArray(i))p=i;else if(i.type==="preset")f=i.append,m=i.excludeDynamicSections;`. i.e. Agent SDK default ≠ Claude Code CLI default. To get Claude Code behavior pass `{type:'preset',preset:'claude_code'}`; `append` maps to the CLI's append-system-prompt. `string[]` may contain `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"`, SDK:6668) marking the cacheable/dynamic split. |
| `settingSources` | `SettingSource[]` = `('user'\|'project'\|'local')[]` (SDK:1870, 6442) | "When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode). Must include `'project'` to load CLAUDE.md files" (SDK:1861-1869). MJS confirms: flag only passed when defined (`if(U!==void 0)W.push(\`--setting-sources=${U.join(",")}\`)`), and the settings-resolution default constant is `["user","project","local"]`. |
| `env` | `{[envVar: string]: string \| undefined}` (SDK:1411-1413) | **REPLACES the subprocess env entirely — not merged.** "Spread `process.env` yourself… When omitted, the subprocess inherits `process.env`." (SDK:1396-1409). `CLAUDE_AGENT_SDK_CLIENT_APP` identifies your app in User-Agent. |
| `pathToClaudeCodeExecutable` | `string` (SDK:1690) | Uses the built-in platform binary if not set. Needed for `bun build --compile` (README). |
| `executable` / `executableArgs` | `'bun'\|'deno'\|'node'` / `string[]` (SDK:1418-1422) | JS runtime for the CLI. MJS default: `executable: ai = Hu() ? "bun" : "node"` (bun if running under bun). |
| `extraArgs` | `Record<string, string \| null>` (SDK:1428) | Extra CLI args; key = arg name without `--`, `null` = boolean flag. Escape hatch for anything not exposed as an option. |
| `stderr` | `(data: string) => void` (SDK:1911) | CLI stderr callback (debug). |
| `mcpServers` | `Record<string, McpServerConfig>` (SDK:1668) | `McpServerConfig = McpStdioServerConfig \| McpSSEServerConfig \| McpHttpServerConfig \| McpSdkServerConfigWithInstance` (SDK:1036). stdio config: `{type?:'stdio', command, args?, env?, timeout?, alwaysLoad?}` (SDK:1135-1149). In-process servers via `createSdkMcpServer({name, version?, instructions?, tools?, alwaysLoad?})` (SDK:467-488) + `tool(name, description, zodShape, handler, extras?)` (SDK:6745-6749). |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` (SDK:1481) | `HookEvent` is the 30-value union at SDK:803; `HookCallbackMatcher = {matcher?: string; hooks: HookCallback[]; timeout?: number}` (SDK:796-801); `HookCallback = (input: HookInput, toolUseID: string \| undefined, options: {signal: AbortSignal}) => Promise<HookJSONOutput>` (SDK:789-794). The shim likely doesn't need hooks for v1 (canUseTool covers permissions), but `PostToolUse` provides `tool_response` + `duration_ms` (SDK:2168-2178) if richer tool metadata is wanted. |
| `agents` | `Record<string, AgentDefinition>` (SDK:1327) | AgentDefinition fields at SDK:38-100 (`description`, `prompt`, `tools?`, `disallowedTools?`, `model?`, `maxTurns?`, `permissionMode?`, `effort?`, …). Use to surface opencode "agents" as Claude subagents if desired. |
| `allowedTools` / `disallowedTools` / `tools` | `string[]` / `string[]` / `string[] \| {type:'preset';preset:'claude_code'}` (SDK:1335,1355,1391-1394) | `allowedTools` = auto-allow without prompting; `tools` = base set of built-ins (`[]` disables all; preset = all Claude Code tools). |
| `thinking` | `ThinkingConfig = ThinkingAdaptive \| ThinkingEnabled \| ThinkingDisabled` (SDK:6719-6743) | `{type:'adaptive', display?:'summarized'\|'omitted'}` \| `{type:'enabled', budgetTokens?, display?}` \| `{type:'disabled'}`. Supersedes deprecated `maxThinkingTokens` (SDK:1633). |
| `effort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` (SDK:1624, EffortLevel SDK:526) | default 'high'. |
| `betas` | `SdkBeta[]` = `'context-1m-2025-08-07'[]` (SDK:1467, 2851) | |
| `persistSession` | `boolean` (SDK:1546) | default `true`; `false` disables `~/.claude/projects/` JSONL persistence (breaks `resume`). Keep `true` — resume is our session store. |
| `outputFormat` | `{type:'json_schema', schema}` (SDK:1686, 898) | structured output; result carries `structured_output`. |
| `title` | `string` (SDK:1991) | Custom session title for NEW sessions; resumed sessions keep their persisted title (use exported `renameSession()` to retitle). |
| `plugins` | `SdkPluginConfig[]` = `{type:'local', path, skipMcpDiscovery?}` (SDK:1731, 4073-4086) | |
| `sandbox` | `SandboxSettings` (SDK:1817) | zod-derived; not needed for shim v1. |
| `spawnClaudeCodeProcess` | `(options: SpawnOptions) => SpawnedProcess` (SDK:2013) | custom spawn (VMs/containers); interfaces at SDK:6481-6556. |
| Also available | `additionalDirectories` (SDK:1292), `agent` (SDK:1311), `toolAliases` (SDK:1381), `toolConfig` (SDK:1455, 6755-6769), `enableFileCheckpointing` (SDK:1444), `strictMcpConfig` (SDK:1919), `skills: string[] \| 'all'` (SDK:1893), `debug`/`debugFile` (SDK:1901-1906), `promptSuggestions` (SDK:1749), `agentProgressSummaries` (SDK:1759), `onElicitation` (SDK:1502), `onUserDialog`/`supportedDialogKinds` (SDK:1516,1538), `includeHookEvents` (SDK:1586), `managedSettings` (SDK:1859), `planModeInstructions` (SDK:1706), `taskBudget` (SDK:1651), `sessionStore`/`sessionStoreFlush`/`loadTimeoutMs` (SDK:1558-1576, alpha). |

---

## 4. Permission surface

### 4.1 `CanUseTool` (SDK:206-254, verbatim)

```ts
export declare type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];   // return these as updatedPermissions for "always allow"
    blockedPath?: string;               // path that triggered the request (e.g. Bash outside allowed dirs)
    decisionReason?: string;
    title?: string;                     // full prompt sentence, e.g. "Claude wants to read foo.txt" — use as primary text
    displayName?: string;               // short noun phrase, e.g. "Read file"
    description?: string;               // human-readable subtitle
    toolUseID: string;                  // unique per tool call within the assistant message
    agentID?: string;                   // set when inside a sub-agent
    requestId: string;                  // control_request envelope id (only needed for out-of-band replies)
}) => Promise<PermissionResult | null>;
```

Return `null` ONLY if you answered the control_request out-of-band; otherwise the tool stays blocked
forever ("Fail-closed… permission prompts have no park deadline", SDK:196-205). **The shim must always
resolve the promise** — including on TUI disconnect (resolve deny) and on session abort.

### 4.2 `PermissionResult` (SDK:2065-2077, verbatim)

```ts
export declare type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdate[];
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;   // 'user_temporary' | 'user_permanent' | 'user_reject' (SDK:2025)
} | {
    behavior: 'deny';
    message: string;
    interrupt?: boolean;
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
};
```

### 4.3 `PermissionUpdate` (SDK:2084-2111, verbatim)

```ts
export declare type PermissionUpdate = {
    type: 'addRules';    rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination;
} | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination;
} | { type: 'removeRules';  rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination;
} | { type: 'setMode';      mode: PermissionMode;          destination: PermissionUpdateDestination;
} | { type: 'addDirectories';    directories: string[];   destination: PermissionUpdateDestination;
} | { type: 'removeDirectories'; directories: string[];   destination: PermissionUpdateDestination; };
// PermissionRuleValue = { toolName: string; ruleContent?: string }        (SDK:2079-2082)
// PermissionBehavior  = 'allow' | 'deny' | 'ask'                          (SDK:2020)
// PermissionUpdateDestination = 'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'  (SDK:2113)
```

Rich wire-level context also exists on the underlying control request `can_use_tool`
(SDK:3509-3533): `decision_reason_type` (`'rule'|'mode'|'subcommandResults'|'permissionPromptTool'|'hook'|'asyncAgent'|'sandboxOverride'|'workingDir'|'safetyCheck'|'classifier'|'other'`),
`classifier_approvable?`, `requires_user_interaction?` — the typed callback surfaces the subset in §4.1.

Auto-denials that never reach `canUseTool` surface as `SDKPermissionDeniedMessage`
(`type:'system', subtype:'permission_denied'`, SDK:4045-4068) with `tool_name`, `tool_use_id`,
`decision_reason_type?`, `message`.

---

## 5. `Query` interface — what exists in 0.3.207 (SDK:2230-2525)

`interface Query extends AsyncGenerator<SDKMessage, void>` — iterate it for messages, call methods for control.
Exhaustive method list (all verified present in 0.3.207):

| Method | Signature | Notes |
|---|---|---|
| `interrupt()` | `(): Promise<SDKControlInterruptResponse \| undefined>` (SDK:2244) | Resolves `{still_queued: string[]}` when CLI advertises `interrupt_receipt_v1` in `system/init.capabilities`; older CLIs resolve `undefined` (SDK:3401-3406). |
| `setPermissionMode(mode)` | `(mode: PermissionMode): Promise<void>` (SDK:2251) | streaming-input only. |
| `setModel(model?)` | `(model?: string): Promise<void>` (SDK:2278) | `undefined` = default. |
| `setMcpPermissionModeOverride(serverName, mode)` | `('default'\|'auto'\|null) → Promise<{warning?}>` (SDK:2268) | tighten-only. |
| `setMaxThinkingTokens(n, display?)` | (SDK:2301) | deprecated; use `thinking` option. |
| `applyFlagSettings(settings)` | (SDK:2320) | mid-session settings merge into the flag layer. |
| `initializationResult()` | `(): Promise<SDKControlInitializeResponse>` (SDK:2329) | cached first-connect result. |
| `reinitialize()` | `(): Promise<SDKControlInitializeResponse>` (SDK:2346) | fresh initialize; redelivers in-flight `can_use_tool` requests. |
| `supportedCommands()` | `(): Promise<SlashCommand[]>` (SDK:2352) | `SlashCommand = {name, description, argumentHint, aliases?}` (SDK:6457-6474). |
| `supportedModels()` | `(): Promise<ModelInfo[]>` (SDK:2358) | **model enumeration** — see §9. |
| `supportedAgents()` | `(): Promise<AgentInfo[]>` (SDK:2364) | `AgentInfo = {name, description, model?}` (SDK:105-118). |
| `mcpServerStatus()` | `(): Promise<McpServerStatus[]>` (SDK:2370) | status ∈ `'connected'\|'failed'\|'needs-auth'\|'pending'\|'disabled'`, plus `tools[]` (SDK:1043-1084). Maps to opencode `GET /mcp` status. |
| `getContextUsage()` | `(): Promise<SDKControlGetContextUsageResponse>` (SDK:2377) | token breakdown incl. `totalTokens`, `maxTokens`, `apiUsage` (SDK:2984-3074). |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` | (SDK:2391) | /usage data + plan rate limits; unstable. |
| `accountInfo()` | `(): Promise<AccountInfo>` (SDK:2424) | `{email?, organization?, subscriptionType?, tokenSource?, apiKeySource?, apiProvider?}` (SDK:23-33). |
| `readFile(path, {maxBytes?, encoding?})` | (SDK:2402) | read gated by Read permission rules. |
| `rewindFiles(userMessageId, {dryRun?})` | (SDK:2433) | needs `enableFileCheckpointing`. Candidate backing for opencode revert, but its granularity is user-message-based. |
| `seedReadState(path, mtime)` | (SDK:2446) | |
| `reloadPlugins()` / `reloadSkills()` | (SDK:2412, 2418) | |
| `reconnectMcpServer(name)` / `toggleMcpServer(name, enabled)` / `setMcpServers(servers)` | (SDK:2460, 2468, 2490) | |
| `streamInput(stream)` | (SDK:2497) | |
| `stopTask(taskId)` / `backgroundTasks(toolUseId?)` | (SDK:2502, 2515) | background task control (Ctrl+B equivalent). |
| `close()` | `(): void` (SDK:2524) | force-kill; no more messages after. |

**Session enumeration exists as top-level exports, not Query methods** (all read
`~/.claude/projects/` JSONL):

- `listSessions(options?): Promise<SDKSessionInfo[]>` (SDK:922); options `{dir?, limit?, offset?, includeWorktrees?, includeProgrammatic?, sessionStore?}` (SDK:927-965).
  `SDKSessionInfo = {sessionId, summary, lastModified, fileSize?, customTitle?, firstPrompt?, gitBranch?, cwd?, tag?, createdAt?}` (SDK:4199-4240).
- `getSessionInfo(sessionId, {dir?})` (SDK:697).
- `getSessionMessages(sessionId, {dir?, limit?, offset?, includeSystemMessages?})`: `Promise<SessionMessage[]>` (SDK:727);
  `SessionMessage = {type:'user'|'assistant'|'system', uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id}` (SDK:4581-4594).
- `getSubagentMessages(sessionId, agentId, opts?)` (SDK:764), `listSubagents(sessionId)` (SDK:977).
- `forkSession(sessionId, {dir?, upToMessageId?, title?}) → {sessionId}` (SDK:668-686).
- `renameSession(sessionId, title)` (SDK:2538), `deleteSession(sessionId)` (SDK:515), `tagSession` (SDK:6676).

`SDKControlInitializeResponse` (SDK:3369-3388, verbatim minus blanks):

```ts
export declare type SDKControlInitializeResponse = {
    commands: coreTypes.SlashCommand[];
    agents: coreTypes.AgentInfo[];
    output_style: string;
    available_output_styles: string[];
    models: coreTypes.ModelInfo[];
    account: coreTypes.AccountInfo;
    fast_mode_state?: coreTypes.FastModeState;   // 'off' | 'cooldown' | 'on' (SDK:608)
};
```

---

## 6. `SDKMessage` union — full inventory (SDK:3908)

```
SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage
  | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage
  | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage
  | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage
  | SDKHookProgressMessage | SDKHookResponseMessage | SDKPluginInstallMessage | SDKToolProgressMessage
  | SDKAuthStatusMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskUpdatedMessage
  | SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage | SDKThinkingTokensMessage
  | SDKSessionStateChangedMessage | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage
  | SDKNotificationMessage | SDKFilesPersistedEvent | SDKToolUseSummaryMessage | SDKMemoryRecallMessage
  | SDKRateLimitEvent | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage
  | SDKPromptSuggestionMessage | SDKMirrorErrorMessage | SDKInformationalMessage | SDKConversationResetMessage
```

Every message carries `uuid: UUID` and `session_id: string` (except optional on input-side
`SDKUserMessage`). Key members verbatim:

### 6.1 `SDKSystemMessage` — `system/init` (SDK:4284-4322)

```ts
export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    agents?: string[];
    apiKeySource: ApiKeySource;          // 'user' | 'project' | 'org' | 'temporary' | 'oauth'  (SDK:124)
    betas?: string[];
    claude_code_version: string;
    cwd: string;
    tools: string[];
    mcp_servers: { name: string; status: string; }[];
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    output_style: string;
    skills: string[];
    plugins: { name: string; path: string; }[];
    fast_mode_state?: FastModeState;
    capabilities?: string[];             // open set; 'interrupt_receipt_v1' known
    uuid: UUID;
    session_id: string;
};
```

First message of every query. `session_id` here is the authoritative Claude session UUID (needed for
`resume`).

### 6.2 `SDKAssistantMessage` (SDK:2786-2820)

```ts
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;                   // full Anthropic Beta message (content blocks + usage), §7
    parent_tool_use_id: string | null;      // non-null ⇒ produced inside the subagent spawned by that tool_use
    error?: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
    request_id?: string;
    supersedes?: UUID[];                    // refusal-fallback: evict these delivered messages
    subagent_type?: string;
    task_description?: string;
};
// SDKAssistantMessageError = 'authentication_failed' | 'oauth_org_not_allowed' | 'billing_error'
//   | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error'
//   | 'unknown' | 'max_output_tokens'                                          (SDK:2822)
```

One `SDKAssistantMessage` per API round-trip ("step"). A single user turn with tool use produces
several of them, interleaved with tool_result-bearing user messages.

### 6.3 `SDKPartialAssistantMessage` — `stream_event` (SDK:4027-4034)

```ts
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    event: BetaRawMessageStreamEvent;       // §7 — raw Anthropic streaming event
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
    ttft_ms?: number;
};
```

Only emitted with `includePartialMessages: true`.

### 6.4 `SDKUserMessageReplay` (SDK:4484-4521)

Same shape as `SDKUserMessage` plus `isReplay: true`, required `uuid`/`session_id`, and
`file_attachments?: unknown[]`. The SDK replays your own prompts back (with stamped uuid) AND emits
tool-result user messages this way. **`tool_use_result`** carries the structured per-tool Output object
(shapes in `SDKTOOLS`, e.g. `AgentOutput`, `BashOutput`, `FileEditOutput` — §8.5); "render from it
instead of parsing the tool_result text" (SDK:4445).

### 6.5 `SDKResultMessage` (SDK:4145-4194)

```ts
export declare type SDKResultSuccess = {
    type: 'result'; subtype: 'success';
    duration_ms: number; duration_api_ms: number;
    ttft_ms?: number; ttft_stream_ms?: number; time_to_request_ms?: number;
    time_to_request_from_spawn_ms?: number; warm_spare_claimed?: boolean; time_origin_ms?: number;
    is_error: boolean; api_error_status?: number | null;
    num_turns: number;
    result: string;                          // final text
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;                 // BetaUsage with nulls stripped (SDK:1244-1246)
    modelUsage: Record<string, ModelUsage>;  // per-model: {inputTokens, outputTokens, cacheReadInputTokens,
                                             //  cacheCreationInputTokens, webSearchRequests, costUSD,
                                             //  contextWindow, maxOutputTokens}                (SDK:1233-1242)
    permission_denials: SDKPermissionDenial[];   // {tool_name, tool_use_id, tool_input}         (SDK:4036-4040)
    structured_output?: unknown;
    deferred_tool_use?: SDKDeferredToolUse;      // {id, name, input}                           (SDK:3737-3741)
    terminal_reason?: TerminalReason;            // 19-value union at SDK:6714
    fast_mode_state?: FastModeState;
    origin?: SDKMessageOrigin;
    uuid: UUID; session_id: string;
};
export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number; duration_api_ms: number; is_error: boolean; num_turns: number;
    stop_reason: string | null; total_cost_usd: number;
    usage: NonNullableUsage; modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason; fast_mode_state?: FastModeState; origin?: SDKMessageOrigin;
    uuid: UUID; session_id: string;
};
```

One result message per user turn. **Keep iterating after `result`** — the stream continues for the next
turn (streaming-input mode) and post-result messages like `prompt_suggestion` (SDK:1736-1748).

### 6.6 `SDKCompactBoundaryMessage` (SDK:2864-2897)

```ts
export declare type SDKCompactBoundaryMessage = {
    type: 'system'; subtype: 'compact_boundary';
    compact_metadata: {
        trigger: 'manual' | 'auto';
        pre_tokens: number;
        post_tokens?: number;
        duration_ms?: number;
        preserved_segment?: { head_uuid: UUID; anchor_uuid: UUID; tail_uuid: UUID; };
        preserved_messages?: { anchor_uuid: UUID; uuids: UUID[]; };
    };
    uuid: UUID; session_id: string;
};
```

### 6.7 Status / lifecycle system messages

```ts
// SDK:4271-4282
export declare type SDKStatus = 'compacting' | 'requesting' | null;
export declare type SDKStatusMessage = {
    type: 'system'; subtype: 'status';
    status: SDKStatus;
    permissionMode?: PermissionMode;
    compact_result?: 'success' | 'failed';
    compact_error?: string;
    uuid: UUID; session_id: string;
};

// SDK:4245-4251 — "'idle' fires after heldBackResult flushes … authoritative turn-over signal"
export declare type SDKSessionStateChangedMessage = {
    type: 'system'; subtype: 'session_state_changed';
    state: 'idle' | 'running' | 'requires_action';
    uuid: UUID; session_id: string;
};

// SDK:2774-2784 — retryable API failure, will be retried
export declare type SDKAPIRetryMessage = {
    type: 'system'; subtype: 'api_retry';
    attempt: number; max_retries: number; retry_delay_ms: number;
    error_status: number | null;
    error: SDKAssistantMessageError;
    uuid: UUID; session_id: string;
};
```

### 6.8 Task/subagent system messages (SDK:4324-4405, 4419-4428)

```ts
export declare type SDKTaskStartedMessage = {
    type: 'system'; subtype: 'task_started';
    task_id: string; tool_use_id?: string; description: string;
    subagent_type?: string; task_type?: string; workflow_name?: string;
    prompt?: string; skip_transcript?: boolean;
    uuid: UUID; session_id: string;
};
export declare type SDKTaskProgressMessage = {
    type: 'system'; subtype: 'task_progress';
    task_id: string; tool_use_id?: string; description: string; subagent_type?: string;
    usage: { total_tokens: number; tool_uses: number; duration_ms: number; };
    last_tool_name?: string; summary?: string;
    uuid: UUID; session_id: string;
};
export declare type SDKTaskNotificationMessage = {
    type: 'system'; subtype: 'task_notification';
    task_id: string; tool_use_id?: string;
    status: 'completed' | 'failed' | 'stopped';
    output_file: string; summary: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number; };
    skip_transcript?: boolean;
    uuid: UUID; session_id: string;
};
export declare type SDKTaskUpdatedMessage = {
    type: 'system'; subtype: 'task_updated';
    task_id: string;
    patch: { status?: 'pending'|'running'|'completed'|'failed'|'killed'|'paused';
             description?: string; end_time?: number; total_paused_ms?: number;
             error?: string; is_backgrounded?: boolean; };
    uuid: UUID; session_id: string;
};
export declare type SDKToolProgressMessage = {
    type: 'tool_progress';
    tool_use_id: string; tool_name: string; parent_tool_use_id: string | null;
    elapsed_time_seconds: number; task_id?: string;
    uuid: UUID; session_id: string;
};
```

### 6.9 Errors/refusals & misc

- `SDKModelRefusalFallbackMessage` (`type:'system', subtype:'model_refusal_fallback'`, SDK:3967-3994):
  `trigger:'refusal'`, `direction:'retry'|'revert'|'sticky'` (only 'retry' still emitted), `original_model`,
  `fallback_model`, `retracted_message_uuids?` (evict those messages), `refused_user_message_uuid?`, `content`.
- `SDKModelRefusalNoFallbackMessage` (subtype `'model_refusal_no_fallback'`, SDK:3999-4010) — refusal with no retry.
- `SDKInformationalMessage` (subtype `'informational'`, SDK:3831-3849): `content`, `level:'info'|'notice'|'suggestion'|'warning'`,
  `tool_use_id?`, `prevent_continuation?`.
- `SDKLocalCommandOutputMessage` (subtype `'local_command_output'`, SDK:3861-3867): `content` — output of local slash commands.
- `SDKThinkingTokensMessage` (subtype `'thinking_tokens'`, SDK:4410-4417): `estimated_tokens`, `estimated_tokens_delta`
  (progress hint while thinking display is omitted/redacted).
- `SDKToolUseSummaryMessage` (`type:'tool_use_summary'`, SDK:4430-4437): `summary`, `preceding_tool_use_ids`.
- `SDKRateLimitEvent` (`type:'rate_limit_event'`, SDK:4114-4122) with `SDKRateLimitInfo` (SDK:4127-4143).
- `SDKConversationResetMessage` (`type:'conversation_reset'`, SDK:3730-3735): `new_conversation_id` — /clear & plan-exit flows.
- `SDKCommandsChangedMessage` (subtype `'commands_changed'`, SDK:2856-2862): REPLACE cached command list.
- `SDKBackgroundTasksChangedMessage` (subtype `'background_tasks_changed'`, SDK:2836-2849): REPLACE-semantics live task set.
- `SDKPermissionDeniedMessage` — §4.3. `SDKAuthStatusMessage` (SDK:2824-2831): `isAuthenticating`, `output[]`, `error?`.
- `SDKNotificationMessage` (subtype `'notification'`, SDK:4015-4025): `key`, `text`, `priority`, `color?`, `timeout_ms?`.

---

## 7. Anthropic Beta raw stream events (BETA)

`BetaRawMessageStreamEvent = BetaRawMessageStartEvent | BetaRawMessageDeltaEvent | BetaRawMessageStopEvent
| BetaRawContentBlockStartEvent | BetaRawContentBlockDeltaEvent | BetaRawContentBlockStopEvent` (BETA:1741).

```ts
export interface BetaRawMessageStartEvent {          // BETA:1734
    message: BetaMessage;                            // content: [], usage seeded, stop_reason: null
    type: 'message_start';
}
export interface BetaRawContentBlockStartEvent {     // BETA:1681
    content_block: BetaTextBlock | BetaThinkingBlock | BetaRedactedThinkingBlock | BetaToolUseBlock
      | BetaServerToolUseBlock | BetaWebSearchToolResultBlock | BetaWebFetchToolResultBlock
      | BetaAdvisorToolResultBlock | BetaCodeExecutionToolResultBlock | BetaBashCodeExecutionToolResultBlock
      | BetaTextEditorCodeExecutionToolResultBlock | BetaToolSearchToolResultBlock | BetaMCPToolUseBlock
      | BetaMCPToolResultBlock | BetaContainerUploadBlock | BetaCompactionBlock | BetaFallbackBlock;
    index: number;
    type: 'content_block_start';
}
export interface BetaRawContentBlockDeltaEvent {     // BETA:1676
    delta: BetaRawContentBlockDelta;                 // BetaTextDelta | BetaInputJSONDelta | BetaCitationsDelta
                                                     //  | BetaThinkingDelta | BetaSignatureDelta | BetaCompactionContentBlockDelta (BETA:1675)
    index: number;
    type: 'content_block_delta';
}
export interface BetaRawContentBlockStopEvent {      // BETA:1689
    index: number;
    type: 'content_block_stop';
}
export interface BetaRawMessageDeltaEvent {          // BETA:1693
    context_management: BetaContextManagementResponse | null;
    delta: { container: BetaContainer | null;
             stop_details: BetaRefusalStopDetails | null;   // {category: 'cyber'|'bio'|'frontier_llm'|'reasoning_extraction'|null, explanation}
             stop_reason: BetaStopReason | null;
             stop_sequence: string | null; };
    type: 'message_delta';
    usage: BetaMessageDeltaUsage;                    // CUMULATIVE tokens (see below)
}
export interface BetaRawMessageStopEvent { type: 'message_stop'; }   // BETA:1738
```

Deltas & blocks:

```ts
export interface BetaTextDelta      { text: string; type: 'text_delta'; }                 // BETA:1969
export interface BetaInputJSONDelta { partial_json: string; type: 'input_json_delta'; }   // BETA:1660 region
export interface BetaThinkingDelta  { estimated_tokens: number | null; thinking: string; type: 'thinking_delta'; }  // BETA:2094
export interface BetaSignatureDelta { signature: string; type: 'signature_delta'; }       // BETA:1907
export interface BetaTextBlock      { citations: BetaTextCitation[] | null; text: string; type: 'text'; }  // BETA:1946
export interface BetaThinkingBlock  { signature: string; thinking: string; type: 'thinking'; }             // BETA:2037
export interface BetaRedactedThinkingBlock { data: string; type: 'redacted_thinking'; }                    // BETA:1742 region
export interface BetaToolUseBlock   { id: string; input: unknown; name: string; type: 'tool_use'; caller?: …; }  // BETA:2637
```

- `BetaStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'compaction'
  | 'refusal' | 'model_context_window_exceeded'` (BETA:1945).
- `BetaUsage` (final, on `BetaMessage.usage`, BETA:2677): `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens: number|null`, `cache_read_input_tokens: number|null`, `cache_creation`,
  `inference_geo`, `iterations`, `output_tokens_details`, `server_tool_use`, `service_tier`, `speed`.
- `BetaMessageDeltaUsage` (streaming, BETA:1521): **cumulative** `input_tokens: number|null`,
  `output_tokens: number`, `cache_creation_input_tokens: number|null`, `cache_read_input_tokens: number|null`,
  `iterations`, `output_tokens_details`, …
- `BetaMessage` (BETA:1396): `{id, container, content: BetaContentBlock[], context_management, diagnostics,
  model, role:'assistant', stop_details, stop_reason, stop_sequence, type:'message', usage}`.

Streaming grammar per API step:
`message_start → (content_block_start → content_block_delta* → content_block_stop)* → message_delta → message_stop`.
Tool-use blocks stream input via `input_json_delta.partial_json` fragments (concatenate → JSON string).
Thinking blocks stream `thinking_delta` then a final `signature_delta`. Redacted thinking arrives as a
complete `content_block_start` with `redacted_thinking` block (opaque `data`), no deltas.

---

## 8. opencode side — verbatim contract (what the shim emits/stores)

### 8.1 Event envelope

TUI SSE handler receives `{payload: Event, directory: string, workspace: string|undefined}` per frame and
skips `payload.type === "sync"` (`OC packages/tui/src/context/event.ts:12-19`). Each `Event` is
`{type: string, properties: {...}}`. Some handlers filter on `workspace === project.workspace.current()`
(`session.error`, `vcs.branch.updated` — `OC packages/tui/src/app.tsx:1018-1029`, `sync.tsx:433-438`), so the
envelope's `directory`/`workspace` must be populated consistently with what the project/workspace endpoints
return (see 01/02 docs).

### 8.2 Events the TUI consumes (traced)

From `OC packages/tui/src/context/sync.tsx:170-440` (switch on `event.type`):

| Event | Payload used | TUI mutation |
|---|---|---|
| `message.updated` | `properties.info` (full Message) | binary-search insert/replace in `store.message[sessionID]` sorted by `id`; >100 messages → oldest evicted (sync.tsx:315-354) |
| `message.removed` | `properties.{sessionID, messageID}` | splice out (355-369) |
| `message.part.updated` | `properties.part` (full Part) | insert/replace in `store.part[messageID]` sorted by `id` (370-390) |
| `message.part.delta` | `properties.{sessionID, messageID, partID, field, delta}` | **string-append**: `part[field] = (existing ?? "") + delta`; dropped if part unknown (392-409) |
| `message.part.removed` | `properties.{sessionID, messageID, partID}` | splice out (411-425) |
| `session.updated` | `properties.info` (full Session) | insert/replace sorted by id (279-292) |
| `session.deleted` | `properties.info.id` | remove (267-278) |
| `session.status` | `properties.{sessionID, status}` | `store.session_status[sessionID] = status` (310-313) |
| `session.diff` | `properties.{sessionID, diff}` | store diff (263-265) |
| `session.next.moved` | `properties.{sessionID, location, subdirectory, timestamp}` | patch session directory/path/workspaceID (294-308) |
| `permission.asked` | `properties` = full PermissionRequest | queue per session; auto-replies "once" when TUI permission.mode==="auto" (190-219) |
| `permission.replied` | `properties.{sessionID, requestID}` | dequeue (175-188) |
| `question.asked` / `question.replied` / `question.rejected` | QuestionRequest / `{sessionID, requestID}` | queue/dequeue (221-257) |
| `todo.updated` | `properties.{sessionID, todos}` | store (259-261) |
| `lsp.updated` | (none — triggers refetch) | (427-431) |
| `vcs.branch.updated` | `properties.branch` | (433-438) |
| `server.instance.disposed` | — | full re-bootstrap (172-174) |
| `session.error` | `properties.error` | toast unless `error.name === "MessageAbortedError"` (`app.tsx:1018-1029`); also OS notifications (`feature-plugins/system/notifications.ts:80`) |

Idle/busy display: the TUI derives "working" from `session_status` AND from the last message —
`status(sessionID)`: `session.time.compacting → "compacting"`; last message `role==="user"` → "working";
else `last.time.completed ? "idle" : "working"` (sync.tsx:578-587). **So the shim must both emit
`session.status` and set `assistant.time.completed`.**

`session.idle` also exists (deprecated but still emitted by real server: `OC packages/schema/src/session-status-event.ts:43-48`;
emission in `OC packages/opencode/src/session/status.ts` `set()` — publishes `Event.Status` always and
`Event.Idle` additionally when idle).

### 8.3 v1 Part / Message schemas (storage + `message.part.updated` payloads)

Source of truth: `OC packages/schema/src/v1/session.ts`. IDs: `MessageID` = `"msg" + ascending()`
(line 17-21), `PartID` = `"prt" + ascending()` (23-27); `ascending()` is a time-ordered 26-char
base62 id (`OC packages/schema/src/identifier.ts:6-30`). **The TUI binary-searches arrays sorted by `id`
(sync.tsx:41-52), so ids MUST be lexicographically increasing in creation order.**

Parts union (`Part`, session.ts:357-370): `text | subtask | reasoning | file | tool | step-start |
step-finish | snapshot | patch | agent | retry | compaction`. All share
`{id: PartID, sessionID, messageID}` (partBase, 81-85). Key shapes (verbatim semantics):

```ts
TextPart      = { ...base, type:"text", text: string, synthetic?: bool, ignored?: bool,
                  time?: {start, end?}, metadata?: Record<string,any> }               // 102-116
ReasoningPart = { ...base, type:"reasoning", text: string, metadata?: {...},
                  time: {start, end?} }                                               // 118-128  (time REQUIRED)
ToolPart      = { ...base, type:"tool", callID: string, tool: string, state: ToolState,
                  metadata?: {...} }                                                  // 315-325
ToolStatePending   = { status:"pending", input: Record<string,any>, raw: string }     // 259-263
ToolStateRunning   = { status:"running", input: {...}, title?, metadata?, time:{start} }        // 266-275
ToolStateCompleted = { status:"completed", input: {...}, output: string, title: string,
                       metadata: Record<string,any>, time:{start, end, compacted?},
                       attachments?: FilePart[] }                                     // 277-290
ToolStateError     = { status:"error", input: {...}, error: string, metadata?, time:{start,end} } // 292-302
StepStartPart  = { ...base, type:"step-start", snapshot?: string }                    // 233-238
StepFinishPart = { ...base, type:"step-finish", reason: string, snapshot?: string, cost: number,
                   tokens: { total?, input, output, reasoning, cache:{read, write} } } // 240-257
FilePart       = { ...base, type:"file", mime, filename?, url, source? }              // 171-179
SubtaskPart    = { ...base, type:"subtask", prompt, description, agent, model?, command? } // 204-218
RetryPart      = { ...base, type:"retry", attempt, error: APIError, time:{created} }  // 220-231
CompactionPart = { ...base, type:"compaction", auto: bool, overflow?: bool, tail_start_id?: MessageID } // 195-202
SnapshotPart   = { ...base, type:"snapshot", snapshot: string }                       // 87-92
PatchPart      = { ...base, type:"patch", hash: string, files: string[] }             // 94-100
AgentPart      = { ...base, type:"agent", name, source? }                             // 181-193
```

Messages (session.ts:332-491):

```ts
User = { id, sessionID, role:"user", time:{created}, format?, summary?,
         agent: string, model: {providerID, modelID, variant?}, system?, tools? }      // 332-355
Assistant = { id, sessionID, role:"assistant", time:{created, completed?},
              error?: AssistantError, parentID: MessageID, modelID, providerID,
              mode: string, agent: string, path:{cwd, root}, summary?: bool,
              cost: number, tokens:{total?, input, output, reasoning, cache:{read,write}},
              structured?, variant?, finish?: string }                                 // 453-488
AssistantError = ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
               | StructuredOutputError | ContextOverflowError | ContentFilterError | APIError
               // discriminated by `name`, each { name, data: {...} }                  // 36-63, 385-394
// APIError.data = { message, statusCode?, isRetryable, responseHeaders?, responseBody?, metadata? }  // 48-55
```

Event payload schemas (session.ts:571-657): `message.updated {sessionID, info}`,
`message.part.updated {sessionID, part, time}` (server stamps `time: Date.now()` —
`OC packages/opencode/src/session/session.ts:637-645`), `message.part.delta {sessionID, messageID,
partID, field, delta}`, `session.error {sessionID?, error?}`,
`session.status {sessionID, status: {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, action?, next}}`
(`OC packages/schema/src/session-status-event.ts:9-40`), `session.compacted {sessionID}`
(`OC packages/schema/src/session-compaction-event.ts:6-11`).

### 8.4 Reference implementation: opencode's own stream→event algorithm

`OC packages/opencode/src/session/processor.ts` is the canonical mapping from an LLM stream to v1
events. Semantics the shim must copy:

- **One assistant message per user turn**, created before streaming; all steps append parts to it.
  `handleEvent` (processor.ts:278-537):
  - `step-start` → new `StepStartPart` via `updatePart` (424-433).
  - `text-start` → create `TextPart{text:"", time:{start}}` + `updatePart` (486-497).
  - `text-delta` → append to in-memory part, emit **only** `updatePartDelta(field:"text")` (499-510).
  - `text-end` → set `time.end`, emit full `updatePart` (authoritative text reconcile) (512-532).
  - `reasoning-start/delta/end` → same pattern with `ReasoningPart` (280-313); orphan deltas silently dropped (294-296).
  - `tool-input-start/delta/end` → **only ensures the pending ToolPart exists; NO delta events for tool input** (315-329).
    Pending state: `{status:"pending", input:{}, raw:""}` (236-245).
  - `tool-call` → transition to `{status:"running", input, time:{start}}` + `updatePart` (331-351).
  - `tool-result` → `{status:"completed", input, output, title, metadata, time:{start,end}}` (160-184, 383-414).
  - `tool-error` → `{status:"error", error, time}` (186-205, 416-419).
  - `step-finish` → close open reasoning parts, update `assistantMessage.{finish,cost,tokens}`, emit
    `StepFinishPart{reason, tokens, cost, snapshot}` + `updateMessage(assistantMessage)` (435-484).
- `process()` wraps the stream with `status.set(sessionID, {type:"busy"})` at start (639), retry policy
  publishing `{type:"retry", attempt, message, next}` statuses (660-674), `halt()` on error →
  `assistantMessage.error = parse(e)` + publish `session.error` + `status.set(idle)` (599-625), and
  `cleanup()` (539-597): close dangling text/reasoning parts, mark unfinished tool parts
  `status:"error", error:"Tool execution aborted", metadata.interrupted:true`, then
  `assistantMessage.time.completed = Date.now()` + `updateMessage`.
- Abort maps to `MessageAbortedError` (halt with `DOMException("Aborted","AbortError")`, 648-654), which
  the TUI suppresses in toasts.

### 8.5 Tool names & input/metadata keys the TUI special-cases

`OC packages/tui/src/routes/session/index.tsx:2630-2649`: special displays for
`bash, glob, read, grep, webfetch, websearch, write, edit, task, apply_patch, todowrite, question, skill, execute`;
everything else renders generically (tool name + `[k=v]` of primitive inputs + `output` string).

Traced reads per renderer (index.tsx, `awk` over each `function X(props: ToolProps)`):

| opencode tool | reads `input.` | reads `state.metadata.` |
|---|---|---|
| `bash` (Shell) | `command`, `workdir`, `description` | `output` (combined stdout/stderr string) |
| `read` | `filePath` | `loaded` |
| `edit` | `filePath`, `replaceAll` | `diff` (unified diff string), `diagnostics` |
| `write` | `filePath`, `content` | `diagnostics` |
| `glob` | `pattern`, `path` | `count` |
| `grep` | `pattern`, `path` | `matches` |
| `webfetch` | `url` | — |
| `websearch` | `query` | `numResults`, `provider` |
| `todowrite` | `todos` | `todos` |
| `question` | `questions` | `answers` |
| `skill` | `name` | — |
| `task` | `description`, `subagent_type` | `sessionId` (**child opencode session id**), `background`; also polls `session_status[metadata.sessionId]` and renders child session's tool titles (index.tsx Task fn) |
| `apply_patch` | — | `files`, `diagnostics` |
| `execute` | — | `error`, `toolCalls` |

**Claude tool names → opencode tool names + input translation** (Claude inputs from `SDKTOOLS`):

| Claude tool (`tool_use.name`) | Claude input (SDKTOOLS) | emit opencode `tool` | input mapping |
|---|---|---|---|
| `Bash` | `{command, timeout?, description?, run_in_background?, dangerouslyDisableSandbox?}` (SDKTOOLS:482) | `bash` | `command` passes through; put combined output in `metadata.output` on completion (from `BashOutput.stdout`+`stderr`, SDKTOOLS:2671) |
| `Read` | `{file_path, offset?, limit?, pages?}` (SDKTOOLS:562) | `read` | `file_path`→`filePath` |
| `Edit` | `{file_path, old_string, new_string, replace_all?}` (SDKTOOLS:544) | `edit` | `file_path`→`filePath`, `replace_all`→`replaceAll`; build `metadata.diff` from `FileEditOutput.structuredPatch`/`gitDiff.patch` (SDKTOOLS:2790-2836) |
| `Write` | `{file_path, content}` (SDKTOOLS:580) | `write` | `file_path`→`filePath` |
| `Glob` | `{pattern, path?}` (SDKTOOLS:590) | `glob` | direct |
| `Grep` | `{pattern, path?, glob?, output_mode?, -A/-B/-C, …}` (SDKTOOLS:600) | `grep` | direct (`pattern`,`path`) |
| `WebFetch` | `{url, prompt}` (SDKTOOLS:774) | `webfetch` | direct |
| `WebSearch` | `{query, allowed_domains?, blocked_domains?}` (SDKTOOLS:784) | `websearch` | direct |
| `TodoWrite` | `{todos: {content, status: 'pending'\|'in_progress'\|'completed', activeForm}[]}` (SDKTOOLS:764) | `todowrite` | statuses map 1:1 to opencode todo statuses (in_progress etc. — also emit `todo.updated`) |
| `Task` (Agent tool) | `AgentInput {description, prompt, subagent_type?, model?, run_in_background?, name?, mode?, isolation?}` (SDKTOOLS:444) | `task` | direct; set `metadata.sessionId` to the shim-created child session (§10.9), `metadata.background` from `run_in_background` |
| `Skill` | `{name?/command…}` | `skill` | direct |
| `AskUserQuestion` | `{questions: [...]}` (SDKTOOLS:798) | `question` | see 04-permissions doc for the Question flow |
| `NotebookEdit`, `TaskOutput`, `TaskStop`, MCP tools (`mcp__server__tool`), etc. | (SDKTOOLS) | keep raw name (lowercasing optional) | generic renderer handles them |

`SDKUserMessage.tool_use_result` for the Task tool is `AgentOutput` (SDKTOOLS:93-190):
completed variant `{agentId, agentType?, content:[{type:'text',text}...], totalToolUseCount,
totalDurationMs, totalTokens, usage{...}, toolStats?, status:'completed', prompt, ...}`; async variant
`{status:'async_launched', agentId, description, outputFile, ...}`.

---

## 9. Auth & model enumeration

**Auth.** Nothing auth-specific in the README beyond data-usage policy. Behavior per source:

- The subprocess inherits `process.env` when `Options.env` is omitted; the Options.env docstring
  explicitly names `ANTHROPIC_API_KEY` as an inheritable variable (SDK:1396-1401). Because the child is
  the Claude Code CLI, all CLI auth paths work unchanged: `ANTHROPIC_API_KEY` env, or the CLI's stored
  OAuth login (keychain / `~/.claude`), or Bedrock/Vertex ambient creds.
- Which path was used is reported on `system/init.apiKeySource: 'user'|'project'|'org'|'temporary'|'oauth'`
  (SDK:4288, 124) and via `Query.accountInfo()` → `AccountInfo.apiProvider:
  'firstParty'|'bedrock'|'vertex'|'foundry'|'anthropicAws'|'mantle'|'gateway'` — "Anthropic OAuth login
  only applies when 'firstParty'; for 3P providers … auth is external (AWS creds, gcloud ADC, etc.)"
  (SDK:23-33).
- Auth-failure surfaces as `SDKAssistantMessage.error`/`api_retry.error` value `'authentication_failed'`
  or `'oauth_org_not_allowed'` (SDK:2822) → map to opencode `ProviderAuthError` (§10.11). Interactive
  auth flows emit `SDKAuthStatusMessage` (SDK:2824-2831).

**Model enumeration.** `Query.supportedModels(): Promise<ModelInfo[]>` (SDK:2358); underlying control
request `list_models` — "in a remote thin-client session the worker's provider, settings cascade, and
enforcement policy decide which models the session can run, so the thin client must ask" (SDK:3408-3413).
`ModelInfo` (SDK:1192-1231, verbatim minus comments):

```ts
export declare type ModelInfo = {
    value: string;                 // model identifier for API calls (may be alias like 'sonnet')
    resolvedModel?: string;        // canonical wire id the alias resolves to (e.g. 'claude-sonnet-5')
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: ('low'|'medium'|'high'|'xhigh'|'max')[];
    supportsAdaptiveThinking?: boolean;
    supportsFastMode?: boolean;
    supportsAutoMode?: boolean;
};
```

The same list arrives in `initializationResult().models`. This backs opencode's
`GET /config/providers` / `provider.list` responses (one synthetic "anthropic"/"claude-code" provider
whose models are `ModelInfo.value`, display = `displayName`). Note: `ModelInfo` has **no context-window
or cost numbers** — `SDKControlGetContextUsageResponse.maxTokens` (SDK:2992) gives the live window, and
`modelUsage[model].contextWindow/maxOutputTokens/costUSD` (SDK:1233-1242) appear on results; opencode
model metadata (limits, cost tables) must otherwise be hardcoded or fetched from models.dev.

---

## 10. THE MAPPING — SDK message ⇒ opencode SSE events + state mutations

Conventions for this section:

- `emit X{...}` = publish SSE event (Bus) AND persist the same mutation in the shim's store (the REST
  endpoints `GET /session/:id/message` etc. must return identical state — the TUI re-fetches on sync,
  `sync.tsx:588-660`).
- `A` = the ONE opencode assistant message for the current user turn (create on first assistant
  activity of the turn; `parentID` = triggering user message id, `time.created=now`, `cost=0`,
  `tokens` zeroed, `mode`/`agent` from session, `path={cwd,root}`, `modelID`/`providerID` from
  `system/init.model` or `session.next.model`).
- Part/message IDs from a monotonic generator (§8.3). Keep maps:
  `blockIndex→partID` (per streaming message), `tool_use_id→{partID, messageID, sessionID}`,
  `parent_tool_use_id→childSessionID`.

### 10.1 Session bootstrap / turn start

| SDK | opencode emission |
|---|---|
| TUI `POST /session/:id/message` (prompt) | create User message + TextPart(s)/FilePart(s); emit `message.updated{info:user}` + `message.part.updated` per part; emit `session.status{status:{type:"busy"}}`. Push `SDKUserMessage` into the query's input iterable. |
| `system/init` (SDK:4284) | No TUI event required. Record `session_id` (for `resume` on process restart), `tools`, `model`, `permissionMode`, `slash_commands`, `capabilities`. Optionally emit `session.updated` if the session's model/agent changed. |
| `stream_event message_start` (parent_tool_use_id=null) | ensure `A` exists → emit `message.updated{info:A}`; emit `message.part.updated{part: StepStartPart{}}` (opencode emits step-start per API step, processor.ts:424-433). |

### 10.2 Text streaming

| SDK stream_event | opencode |
|---|---|
| `content_block_start` w/ `content_block.type==='text'` | create `TextPart{text:"", time:{start:now}}`; map `index→partID`; emit `message.part.updated` (full part) |
| `content_block_delta` w/ `text_delta` | append to stored part text; emit `message.part.delta{messageID, partID, field:"text", delta:event.delta.text}` (TUI appends, sync.tsx:392-409) |
| `content_block_stop` (text block) | set `time.end=now`; emit `message.part.updated` with full accumulated text (authoritative reconcile — safe because TUI `reconcile()` replaces) |

The final `SDKAssistantMessage.message.content` contains the complete `text` blocks — use it to verify/
repair accumulated text (dropped deltas) before the `content_block_stop` reconcile if desired.

### 10.3 Thinking / reasoning

| SDK | opencode |
|---|---|
| `content_block_start` w/ `thinking` block | create `ReasoningPart{text:"", time:{start:now}}` (time.start REQUIRED, schema session.ts:123-126); emit `message.part.updated` |
| `thinking_delta` | append `delta.thinking`; emit `message.part.delta{field:"text", delta}` |
| `signature_delta` | store in `part.metadata.signature` (no event needed, or fold into final part.updated) |
| `content_block_stop` (thinking) | set `time.end`; emit full `message.part.updated` |
| `content_block_start` w/ `redacted_thinking` block | create `ReasoningPart{text:"", time:{start:now,end:now}, metadata:{redacted:true, data:block.data}}`; single `message.part.updated`. TUI renders reasoning `text` only — an empty redacted part renders as nothing/collapsed, which is acceptable; alternatively use text `"[thinking redacted]"`. |
| `system/thinking_tokens` (SDK:4410) | optional: ignore, or surface via `session.status` message text. No opencode equivalent. |

### 10.4 Tool calls (input streaming → running → done)

| SDK | opencode |
|---|---|
| `content_block_start` w/ `tool_use` block (`id`,`name`) | create `ToolPart{callID:block.id, tool:mapName(name), state:{status:"pending", input:{}, raw:""}}`; register `tool_use_id→part`; emit `message.part.updated`. (v1 contract has NO input-delta event — opencode's own processor emits nothing on `tool-input-delta`, processor.ts:322-324.) |
| `input_json_delta` | accumulate `raw += partial_json` in stored pending state; **no event** (optional: re-emit `message.part.updated` throttled if you want live input) |
| `content_block_stop` (tool_use block) | parse accumulated JSON → keep pending with parsed `input` (or transition below if no permission gate) |
| `canUseTool(toolName, input, opts)` fires | emit `permission.asked{...}` (PermissionRequest `{id, sessionID, permission, patterns, metadata, always, tool:{messageID, callID}}` — v2 gen types.gen.ts:2463-2476; see 04 doc). On TUI reply: resolve `PermissionResult`; emit `permission.replied{sessionID, requestID}`. On deny also mark the tool part error (the SDK will send an is_error tool_result anyway — prefer waiting for it). |
| tool starts executing — signal = `SDKAssistantMessage` containing the final `tool_use` block (post-permission), or first `tool_progress` | transition part → `{status:"running", input, time:{start:now}}`; emit `message.part.updated` |
| `tool_progress` (SDK:4419) | optional: update `state.title`/`metadata` + `message.part.updated` (throttle) |
| **tool_result** — arrives as `SDKUserMessageReplay` whose `message.content` includes `{type:'tool_result', tool_use_id, content, is_error?}` blocks, with the structured tool Output in `tool_use_result` (SDK:4439-4492) | success: `{status:"completed", input, output:<stringified tool_result content>, title:<derived>, metadata:<from tool_use_result, translated per §8.5>, time:{start,end:now}}`; error (`is_error:true`): `{status:"error", input, error:<text>, time:{start,end}}`. Emit `message.part.updated`. |
| `system/permission_denied` (SDK:4045) | mark tool part error with `message` if a tool_result doesn't follow; else informational only |

`tool_result` content is `string | Array<{type:'text'|'image',...}>` (Anthropic `ToolResultBlockParam`);
flatten text blocks to the `output` string; convert image blocks to `attachments` FileParts if desired
(ToolStateCompleted.attachments, session.ts:288).

**Do NOT create a user-role opencode message for tool-result user messages** — opencode keeps tool
results inside the assistant message's ToolPart; a fake user message would flip the TUI status logic
(`last.role==="user" → "working"`, sync.tsx:585).

### 10.5 Step & token/cost accounting

| SDK | opencode |
|---|---|
| `message_delta` (stop_reason + cumulative usage) | compute step tokens: `input=usage.input_tokens ?? msgstart`, `output=usage.output_tokens`, `reasoning=0` (or from `output_tokens_details`), `cache={read:cache_read_input_tokens??0, write:cache_creation_input_tokens??0}`. Buffer until `message_stop`. |
| `message_stop` (or the step's `SDKAssistantMessage`, whose `message.usage: BetaUsage` is final) | emit `message.part.updated{part: StepFinishPart{reason: mapStop(stop_reason), cost: <computed>, tokens}}`; update `A.tokens` (cumulative), `A.finish=mapStop(...)`; emit `message.updated{info:A}` (processor.ts:435-456 does exactly this). |
| `result` (`SDKResultSuccess`/`SDKResultError`) | `A.cost = total_cost_usd` (authoritative — SDK computes cost; per-model in `modelUsage[*].costUSD`); `A.tokens` from `usage` (NonNullableUsage); `A.time.completed = now`; emit `message.updated{info:A}`. Update Session `cost`/`tokens`; emit `session.updated`. Then `session.status{status:{type:"idle"}}` + `session.idle{sessionID}`. |

`mapStop`: `end_turn→"stop"`, `tool_use→"tool-calls"`, `max_tokens→"length"`,
`stop_sequence→"stop"`, `refusal→"content-filter"`, `pause_turn→"unknown"`, `compaction→"unknown"`,
`model_context_window_exceeded→"length"` (opencode `finish`/`reason` is a free string —
StepFinishPart.reason `Schema.String`, session.ts:243 — the AI-SDK vocabulary above is what real servers
store; TUI does not switch on it).

Cost: prefer `result.total_cost_usd` / `modelUsage[model].costUSD` (SDK:1233-1242) over recomputing from
tokens. Mid-turn StepFinishPart.cost may be 0 and corrected at result time.

### 10.6 Turn-over / idle

`SDKSessionStateChangedMessage.state==='idle'` is the "authoritative turn-over signal" (SDK:4242-4251) —
emit `session.status{type:"idle"}` + `session.idle` on it as well as after `result` (idempotent).
`state==='running'` → `{type:"busy"}`. `requires_action` → keep busy (a permission/question is pending).

### 10.7 Retries

`system/api_retry` (SDK:2774) → emit `session.status{status:{type:"retry", attempt, message:
humanize(error), next: Date.now()+retry_delay_ms}}` (schema session-status-event.ts:13-27). Optionally
also a `RetryPart{attempt, error:APIError{...}, time:{created}}` on `A` (session.ts:220-231). Return to
`{type:"busy"}` implicitly on next stream activity (real server keeps status until next set).

### 10.8 Interrupt / abort

TUI abort endpoint → `query.interrupt()` (SDK:2244). Then: cleanup like processor.cleanup()
(§8.4) — close open text/reasoning parts, fail running tools with `"Tool execution aborted"` +
`metadata.interrupted:true`, set `A.error = {name:"MessageAbortedError", data:{message:"..."}}`,
`A.time.completed=now`, emit `message.updated`, `session.error{sessionID, error:{name:"MessageAbortedError",...}}`
(TUI suppresses its toast, app.tsx:1021), `session.status idle` + `session.idle`.

### 10.9 Subagents (`parent_tool_use_id` → Task tool → child session)

Traced TUI contract: a `task` ToolPart with `state.metadata.sessionId` = child session id; the TUI
lazy-syncs that session and lists child sessions by `session.parentID`
(routes/session/index.tsx Task fn + :207-212 `children` memo).

| SDK | opencode |
|---|---|
| `tool_use` block named `Task`/`Agent` (input `AgentInput`) | as §10.4, tool name `task`; ALSO create child Session `{id:new, parentID:parent.id, title:input.description, directory, projectID, ...}` → emit `session.updated{info:child}`; set part `state.metadata.sessionId=child.id`, `metadata.background = input.run_in_background===true`; emit `message.part.updated` |
| any SDKMessage with `parent_tool_use_id === that tool_use id` (assistant/stream_event/user-replay; full text only with `forwardSubagentText:true`, SDK:1592-1598) | apply the same mapping recursively INTO the child session (child assistant message, parts, deltas). Emit `session.status busy` for the child while active. |
| `system/task_started` (`tool_use_id` set) | correlate task_id↔tool_use_id; set part `state.title=description`; child session title |
| `system/task_progress` | optional: update part title/`metadata` (`summary`, `last_tool_name`, usage) + `message.part.updated` (throttled); child stays busy |
| `system/task_notification` (`status:'completed'\|'failed'\|'stopped'`) | child `session.status idle` + `session.idle`; if the parent tool_result hasn't arrived yet, keep part running — completion comes from the parent-side tool_result (§10.4) whose `tool_use_result` is `AgentOutput` |
| `tool_use_result: AgentOutput{status:'completed', content, totalTokens, ...}` | ToolPart completed: `output` = joined `content[].text`, `metadata` += `{sessionId, totalTokens, totalDurationMs, totalToolUseCount}` |

Depth: `SessionMessage.parent_agent_id` (SDK:4593) exists only in transcript reads; live messages carry
a single `parent_tool_use_id` hop — nested subagents' events arrive attributed to their own parent tool id.

### 10.10 Compaction

| SDK | opencode |
|---|---|
| `system/status{status:'compacting'}` (SDK:4271-4282) | emit `session.updated` with `time.compacting=now` (TUI status() → "compacting", sync.tsx:581) and/or keep `session.status busy` |
| `system/compact_boundary{compact_metadata:{trigger, pre_tokens}}` (SDK:2864) | mimic real server (compaction.ts:518-536 + 470-509): create a new User message w/ `CompactionPart{auto: trigger==='auto'}` → `message.updated` + `message.part.updated`; then an assistant message with `summary:true` containing the compaction summary text if you have one (the SDK does not stream the summary text — acceptable to emit the boundary only) |
| `system/status{status:null, compact_result:'success'}` | clear `time.compacting` → `session.updated`; emit `session.compacted{sessionID}` (schema session-compaction-event.ts:6-11) |
| `system/status{compact_result:'failed', compact_error}` | `session.error{error:{name:"UnknownError", data:{message:compact_error}}}`; clear compacting |

### 10.11 Errors & refusals → `session.error`

Emit `session.error{sessionID, error}` + set `A.error` + `A.time.completed` + `message.updated` + idle.
Error mapping (opencode error union at session.ts:385-394):

| SDK signal | opencode `error.name` |
|---|---|
| `error:'authentication_failed'` / `'oauth_org_not_allowed'` (SDK:2822) | `ProviderAuthError` `{providerID:"anthropic", message}` |
| `'billing_error'` | `APIError` (statusCode 402-ish, isRetryable:false) |
| `'rate_limit'` / `'overloaded'` / `'server_error'` | `APIError` `{message, statusCode?, isRetryable:true}` |
| `'invalid_request'` / `'model_not_found'` | `APIError` `{isRetryable:false}` |
| `'max_output_tokens'` | `MessageOutputLengthError` `{}` |
| `'unknown'` | `UnknownError` `{message}` |
| abort/interrupt | `MessageAbortedError` `{message}` (TUI-silent) |
| `result subtype:'error_max_turns'`/`'error_max_budget_usd'`/`'error_during_execution'`/`'error_max_structured_output_retries'` | `UnknownError` with joined `errors[]` (or `StructuredOutputError{message, retries}` for the last) |
| `model_refusal_no_fallback` / stop_reason `'refusal'` | `ContentFilterError` `{message: content}` |
| `model_refusal_fallback` (retry ran) | no session.error; evict `retracted_message_uuids` → for each retracted message that maps to emitted opencode parts: `message.part.removed` / `message.removed`; the retry stream then re-emits |
| context overflow (`model_context_window_exceeded` w/o auto-compact) | `ContextOverflowError` `{message}` |

### 10.12 No-op / optional SDK messages

`SDKUserMessageReplay` of your own prompt (dedupe by uuid/known text) — no event (the shim already
emitted the user message at POST time). `commands_changed`, `background_tasks_changed`,
`plugin_install`, `files_persisted`, `memory_recall`, `rate_limit_event`, `elicitation_complete`,
`mirror_error`, `worker_shutting_down`, `hook_*`, `control_request_progress`, `tool_use_summary`,
`prompt_suggestion`, `conversation_reset`, `notification`, `auth_status`, `local_command_output`,
`informational` — no v1 TUI consumer; safest to ignore (optionally: `informational`/`notification` →
`tui.toast.show` if that event is implemented; `local_command_output` → synthetic TextPart).

### 10.13 Optional dual-emit: `session.next.*`

If the shim also emits v2 events (only needed for `session.next.moved` in sync.tsx and the data.tsx
consumers), the payloads are in `OC packages/sdk/js/src/v2/gen/types.gen.ts:815-1192`. 1:1 with the
mapping above: `step.started{assistantMessageID, agent, model}` / `step.ended{finish, cost, tokens}` /
`step.failed{error}`; `text.started/delta/ended{textID}`; `reasoning.started/delta/ended{reasoningID}`;
`tool.input.started{callID,name}` → `tool.input.delta{delta}` → `tool.input.ended{text}` →
`tool.called{callID, tool, input, provider:{executed}}` → `tool.progress{structured, content}` →
`tool.success{structured, content, result?, provider}` / `tool.failed{error, result?, provider}`;
`prompted{prompt, delivery}`; `compaction.started/delta/ended`; `retried{attempt, error}`. All carry
`{timestamp, sessionID}`; TUI data.tsx handling at data.tsx:124-403.

---

## 11. Minimal JSON examples (copy-paste shapes the shim can emit)

Assistant message create/update (`message.updated`):

```json
{"type":"message.updated","properties":{"sessionID":"ses_abc","info":{
  "id":"msg_01","sessionID":"ses_abc","role":"assistant",
  "time":{"created":1770000000000},
  "parentID":"msg_00","modelID":"claude-fable-5","providerID":"anthropic",
  "mode":"build","agent":"build","path":{"cwd":"/w","root":"/w"},
  "cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}}}
```

Text part start + delta + end:

```json
{"type":"message.part.updated","properties":{"sessionID":"ses_abc","time":1770000000001,
 "part":{"id":"prt_01","sessionID":"ses_abc","messageID":"msg_01","type":"text","text":"","time":{"start":1770000000001}}}}
{"type":"message.part.delta","properties":{"sessionID":"ses_abc","messageID":"msg_01","partID":"prt_01","field":"text","delta":"Hello"}}
{"type":"message.part.updated","properties":{"sessionID":"ses_abc","time":1770000000900,
 "part":{"id":"prt_01","sessionID":"ses_abc","messageID":"msg_01","type":"text","text":"Hello world.","time":{"start":1770000000001,"end":1770000000900}}}}
```

Tool part lifecycle:

```json
{"type":"message.part.updated","properties":{"sessionID":"ses_abc","time":1,"part":{
 "id":"prt_02","sessionID":"ses_abc","messageID":"msg_01","type":"tool","callID":"toolu_01","tool":"bash",
 "state":{"status":"pending","input":{},"raw":""}}}}
{"type":"message.part.updated","properties":{"sessionID":"ses_abc","time":2,"part":{
 "id":"prt_02","sessionID":"ses_abc","messageID":"msg_01","type":"tool","callID":"toolu_01","tool":"bash",
 "state":{"status":"running","input":{"command":"ls","description":"List files"},"time":{"start":1770000001000}}}}}
{"type":"message.part.updated","properties":{"sessionID":"ses_abc","time":3,"part":{
 "id":"prt_02","sessionID":"ses_abc","messageID":"msg_01","type":"tool","callID":"toolu_01","tool":"bash",
 "state":{"status":"completed","input":{"command":"ls"},"output":"README.md\n","title":"ls",
          "metadata":{"output":"README.md\n"},"time":{"start":1770000001000,"end":1770000002000}}}}}
```

Step finish + final message + idle:

```json
{"type":"message.part.updated","properties":{"sessionID":"ses_abc","time":4,"part":{
 "id":"prt_03","sessionID":"ses_abc","messageID":"msg_01","type":"step-finish","reason":"stop","cost":0.0123,
 "tokens":{"input":1200,"output":250,"reasoning":0,"cache":{"read":9000,"write":300}}}}}
{"type":"message.updated","properties":{"sessionID":"ses_abc","info":{"id":"msg_01","sessionID":"ses_abc","role":"assistant",
 "time":{"created":1770000000000,"completed":1770000003000},"parentID":"msg_00","modelID":"claude-fable-5",
 "providerID":"anthropic","mode":"build","agent":"build","path":{"cwd":"/w","root":"/w"},"finish":"stop",
 "cost":0.0123,"tokens":{"input":1200,"output":250,"reasoning":0,"cache":{"read":9000,"write":300}}}}}
{"type":"session.status","properties":{"sessionID":"ses_abc","status":{"type":"idle"}}}
{"type":"session.idle","properties":{"sessionID":"ses_abc"}}
```

Error:

```json
{"type":"session.error","properties":{"sessionID":"ses_abc",
 "error":{"name":"APIError","data":{"message":"overloaded","statusCode":529,"isRetryable":true}}}}
```

---

## 12. Traps & gotchas (implementer checklist)

1. **`Options.env` REPLACES the child env** (SDK:1396-1401). Always spread `process.env` if setting it.
2. **Default system prompt is EMPTY**, not Claude Code's (MJS `if(i===void 0)p=""`). Pass
   `systemPrompt: {type:'preset', preset:'claude_code'}` for CLI-equivalent behavior.
3. **`includePartialMessages: true` or no streaming** — without it you only get whole
   `SDKAssistantMessage`s per step.
4. **`canUseTool` must always resolve**; returning `null` without out-of-band reply blocks the tool
   forever (SDK:196-205). Deny with a message on TUI disconnect/timeout. It can't be combined with
   `permissionPromptToolName` (MJS error string).
5. **Control methods require streaming-input mode** (SDK:2231-2235): `interrupt`, `setModel`,
   `setPermissionMode`, `supportedModels`, etc.
6. **Keep iterating after `result`** — the generator continues (next turns, `prompt_suggestion`,
   SDK:1740-1742).
7. **IDs must sort ascending**: TUI binary-searches messages/parts sorted by `id`
   (sync.tsx:41-52, 322, 377); use `msg_`/`prt_`/`ses_` prefixes + a time-ordered suffix
   (identifier.ts:14-30). Wrong ordering silently corrupts the transcript.
8. **Set `assistant.time.completed`** at turn end or the TUI spins "working" forever (sync.tsx:586).
   Equally: never leave a trailing user-role message without an assistant reply (status logic
   sync.tsx:585) — don't materialize tool_result user messages.
9. **Delta + final reconcile**: emit `message.part.delta` for streams and a final full
   `message.part.updated` (opencode's own pattern, processor.ts:499-532). The TUI append is
   `(existing ?? "") + delta` and the final update replaces — do NOT re-send full text as a delta.
10. **No tool-input delta event exists in v1** — accumulate `input_json_delta` silently
    (processor.ts:322-324 does the same).
11. **`message_delta.usage` is cumulative** per step (BETA:1521 "cumulative"), and
    `SDKResultMessage.usage` covers the turn. Don't sum step usages AND result usage.
12. **Tool naming/casing matters**: TUI special-cases lowercase `bash/read/edit/...` and reads
    camelCase input keys (`filePath`), while Claude emits `Bash`/`file_path`. Translate names and
    inputs (§8.5) or everything renders through GenericTool.
13. **Task tool child sessions**: TUI reads `state.metadata.sessionId` and `session.parentID` to show
    subagents; without them "view subagents" is dead (routes/session/index.tsx:1495-1518, Task fn).
    Set `forwardSubagentText: true` to have content to route into the child session (SDK:1592-1598).
14. **`MessageAbortedError` is special-cased silent** in TUI toasts (app.tsx:1021) — use it for
    interrupts, not `UnknownError`.
15. **Refusal fallback retracts messages** (`supersedes`, `retracted_message_uuids`, SDK:2795-2797,
    3984-3990): keep uuid→emitted-entity maps so you can emit `message.part.removed`/`message.removed`.
16. **`session_id` from `system/init` is the resume key**; `persistSession` must stay true (default)
    for `resume`/`forkSession` to work (SDK:1539-1546). opencode session ids (`ses_…`) and Claude
    session UUIDs differ — store the mapping.
17. **One `query()` per opencode session** (cwd + model + permissionMode are per-process); use
    `resume` + streaming iterable to span turns; `interrupt()` for abort — do NOT kill the process per
    turn or you pay spawn latency (or use `startup()` warm spares, SDK:6558-6565).
18. **`stream_event`s for subagents share the parent stream** with `parent_tool_use_id` set
    (SDK:4030) — route by that field FIRST, before block-index bookkeeping, or parallel subagent
    text will interleave into the main transcript.
19. **Unknown-message tolerance**: `SDKMessage` is a large open union that grows; switch on
    `type`/`subtype` and default to ignore.
20. **Bun compiled binaries** need `pathToClaudeCodeExecutable` + `extractFromBunfs` (README) —
    affects packaging, not dev.
