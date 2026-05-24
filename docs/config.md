# Configuration

Fleet uses three YAML files, usually under `~/.config/fleet`.

## models.yaml

```yaml
models:
  local-qwen:
    provider: openai-compatible
    baseUrl: http://localhost:1234/v1
    modelId: qwen/qwen3.6-27b
    apiKeyEnv: null
    modalities: [text, image]
    contextWindow: 131072
    outputBudget: 4000
    reasoning: medium
```

## agents.yaml

```yaml
agents:
  - name: planner
    rolePreset: planner
    runtime: cline
    role: architecture and migration planner
    model: local-qwen
    profile: planner
    phase: plan
    prompt: prompts/planner.md
    thinking: high
    autoApprove: true
    permissions:
      mode: read-only
      tools: [read, search]
      mcp: profile
```

`runtime` defaults to `cline` when omitted. Supported values are `cline`, `claude-code`, `codex`, `openai-compatible-direct`, `custom-command`, and `aider`.

`permissions.mode` is used by Fleet and the UI to make write intent visible. Read-only pipeline phases use safe planning behavior; write phases are only used by explicit implementation pipelines. Direct API workers are read-only and cannot use MCP/tools.

Custom command agents can add:

```yaml
runtime: custom-command
runtimeCommand: ./scripts/my-worker
runtimeConfig:
  env:
    FOO: bar
```

## pipelines.yaml

```yaml
pipelines:
  default:
    description: Safe plan/review pipeline.
    phases:
      - name: recon
        mode: parallel
        agents: [repo-a, repo-b]
        inputs: []
        readOnly: true
        compaction: basic
        maxInputBytes: 120000
        maxOutputWords: 2000
```

Use `inputs` to decide which earlier phase outputs feed the current phase. Use `maxInputBytes` and `maxOutputWords` to keep handoffs bounded.
