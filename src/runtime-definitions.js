export const DEFAULT_RUNTIME = "cline";

export const RUNTIME_DEFINITIONS = {
  cline: {
    id: "cline",
    label: "Cline",
    command: "cline",
    maturity: "stable",
    summary: "Default coding worker with profiles, MCP, worktrees, JSON logs, plan mode, and write phases.",
    supportsWrite: true,
    supportsMcp: true,
    supportsMultimodal: true,
    supportsWorktree: true,
    supportsDirectApi: false,
    configurableModel: true,
    capabilities: ["read", "search", "edit", "shell", "mcp", "worktree", "json", "multimodal"]
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    maturity: "supported",
    summary: "Headless Claude Code worker for planning, review, and implementation when Claude auth is configured.",
    supportsWrite: true,
    supportsMcp: true,
    supportsMultimodal: true,
    supportsWorktree: true,
    supportsDirectApi: false,
    configurableModel: true,
    capabilities: ["read", "search", "edit", "shell", "mcp", "worktree", "stream-json", "multimodal"]
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    maturity: "supported",
    summary: "Codex CLI worker for non-interactive planning, reviews, and write-capable tasks.",
    supportsWrite: true,
    supportsMcp: true,
    supportsMultimodal: true,
    supportsWorktree: false,
    supportsDirectApi: false,
    configurableModel: true,
    capabilities: ["read", "search", "edit", "shell", "mcp", "json", "multimodal"]
  },
  "openai-compatible-direct": {
    id: "openai-compatible-direct",
    label: "Direct API",
    command: null,
    maturity: "stable",
    summary: "Lightweight direct /chat/completions worker for read-only planning, review, and synthesis.",
    supportsWrite: false,
    supportsMcp: false,
    supportsMultimodal: false,
    supportsWorktree: false,
    supportsDirectApi: true,
    configurableModel: true,
    capabilities: ["read-only", "chat-completions", "no-tools"]
  },
  "custom-command": {
    id: "custom-command",
    label: "Custom Command",
    command: null,
    maturity: "advanced",
    summary: "User-defined executable adapter. Fleet supplies prompt/context through stdin and env variables.",
    supportsWrite: true,
    supportsMcp: false,
    supportsMultimodal: false,
    supportsWorktree: false,
    supportsDirectApi: false,
    configurableModel: false,
    capabilities: ["stdin", "env", "advanced"]
  },
  aider: {
    id: "aider",
    label: "Aider",
    command: "aider",
    maturity: "experimental",
    summary: "Experimental file-oriented coding worker. Shown when installed; enable per agent before live use.",
    supportsWrite: true,
    supportsMcp: false,
    supportsMultimodal: false,
    supportsWorktree: false,
    supportsDirectApi: false,
    configurableModel: true,
    capabilities: ["read", "edit", "repo-map", "experimental"]
  }
};

export const RUNTIME_IDS = Object.keys(RUNTIME_DEFINITIONS);

export function runtimeDefinition(id) {
  return RUNTIME_DEFINITIONS[id] || null;
}

export function isKnownRuntime(id) {
  return Boolean(runtimeDefinition(id));
}
