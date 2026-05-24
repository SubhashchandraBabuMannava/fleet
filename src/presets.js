export const ROLE_PRESETS = [
  {
    id: "repo-mapper",
    label: "Repo Mapper",
    phase: "recon",
    role: "read-only repo mapper",
    thinking: "medium",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read", "search"],
      mcp: "profile"
    },
    prompt: [
      "Map the repository for downstream agents.",
      "Focus on relevant files, conventions, build/test commands, risks, and what not to touch.",
      "Do not edit files."
    ].join("\n")
  },
  {
    id: "skeptic",
    label: "Skeptic",
    phase: "recon",
    role: "skeptical edge-case finder",
    thinking: "medium",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read", "search"],
      mcp: "profile"
    },
    prompt: [
      "Look for edge cases, hidden assumptions, risky files, and likely failure modes.",
      "Prefer concrete file paths and test scenarios.",
      "Do not edit files."
    ].join("\n")
  },
  {
    id: "compactor",
    label: "Compactor",
    phase: "compact",
    role: "context compactor and handoff summarizer",
    thinking: "medium",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read"],
      mcp: "profile"
    },
    prompt: [
      "Compress upstream reports into a short context pack.",
      "Deduplicate, preserve exact paths/symbols/commands, and keep uncertainty visible."
    ].join("\n")
  },
  {
    id: "planner",
    label: "Planner",
    phase: "plan",
    role: "implementation planner",
    thinking: "high",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read", "search"],
      mcp: "profile"
    },
    prompt: [
      "Produce a practical implementation plan.",
      "Include assumptions, file targets, phased steps, risks, validation commands, and rollback notes."
    ].join("\n")
  },
  {
    id: "coder",
    label: "Coder",
    phase: "implement",
    role: "minimal scoped implementation agent",
    thinking: "high",
    autoApprove: false,
    permissions: {
      mode: "write",
      tools: ["read", "search", "edit", "shell"],
      mcp: "profile"
    },
    prompt: [
      "Implement the supplied plan with minimal scoped changes.",
      "Avoid broad refactors, preserve public behavior unless explicitly changed, and run relevant tests when possible."
    ].join("\n")
  },
  {
    id: "reviewer",
    label: "Correctness Reviewer",
    phase: "review",
    role: "adversarial correctness reviewer",
    thinking: "high",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read", "search"],
      mcp: "profile"
    },
    prompt: [
      "Review the plan, implementation summary, or diff.",
      "Severity-rank correctness bugs, regressions, missing tests, and edge cases."
    ].join("\n")
  },
  {
    id: "security-reviewer",
    label: "Security Reviewer",
    phase: "review",
    role: "security and production safety reviewer",
    thinking: "high",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read", "search"],
      mcp: "profile"
    },
    prompt: [
      "Review security, privacy, production safety, and operational risks.",
      "Only report concrete risks with actionable fixes."
    ].join("\n")
  },
  {
    id: "test-reviewer",
    label: "Test Reviewer",
    phase: "review",
    role: "test and validation reviewer",
    thinking: "medium",
    autoApprove: true,
    permissions: {
      mode: "read-only",
      tools: ["read", "search"],
      mcp: "profile"
    },
    prompt: [
      "Identify validation gaps and the smallest useful test set.",
      "Prefer exact commands and acceptance scenarios."
    ].join("\n")
  },
  {
    id: "coordinator",
    label: "Coordinator",
    phase: "final",
    role: "final coordinator and decision maker",
    thinking: "high",
    autoApprove: false,
    permissions: {
      mode: "read-only",
      tools: ["read"],
      mcp: "profile"
    },
    prompt: [
      "Synthesize upstream reports into a concise decision.",
      "Call out must-fix items, safe-to-commit status, next commands, and rollback notes."
    ].join("\n")
  }
];

export const MODEL_TEMPLATES = [
  {
    id: "lm-studio-qwen-pc",
    label: "LM Studio qwen-pc",
    provider: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    modelId: "qwen-pc",
    apiKeyEnv: null,
    modalities: ["text"],
    contextWindow: 131072,
    outputBudget: 4000,
    reasoning: "medium"
  },
  {
    id: "openai-compatible-local",
    label: "Local OpenAI-Compatible",
    provider: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    modelId: "local-model-id",
    apiKeyEnv: null,
    modalities: ["text"],
    contextWindow: 32768,
    outputBudget: 4000,
    reasoning: "medium"
  },
  {
    id: "nvidia-glm",
    label: "NVIDIA GLM Text",
    provider: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: "z-ai/glm-5.1",
    apiKeyEnv: "NVIDIA_API_KEY",
    modalities: ["text"],
    contextWindow: 65536,
    outputBudget: 6000,
    reasoning: "high"
  }
];

export const PIPELINE_TEMPLATES = [
  {
    id: "safe-plan-review",
    label: "Safe Plan + Review",
    description: "Read-only recon, compaction, plan, review, and final synthesis.",
    phases: ["recon", "compact", "plan", "review", "final"]
  },
  {
    id: "implement-with-review",
    label: "Implement + Review",
    description: "Plan first, implement explicitly, capture diff, then review and synthesize.",
    phases: ["recon", "compact", "plan", "implement", "capture_diff", "review", "final"]
  },
  {
    id: "fast-review",
    label: "Fast Review",
    description: "Skip implementation and use fewer handoff steps for quick checks.",
    phases: ["recon", "plan", "review", "final"]
  }
];

export function rolePreset(id) {
  return ROLE_PRESETS.find((preset) => preset.id === id);
}
