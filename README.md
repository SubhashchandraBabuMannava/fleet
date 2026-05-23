# Fleet

Config-driven local multi-agent teams with pluggable worker runtimes.

Fleet keeps Cline as the default coding worker, but agents can also use Claude Code, Codex CLI, direct OpenAI-compatible calls, Aider, or a custom command. The Studio UI is task-first: setup, model discovery, team roles, workflow steps, prompts, permissions, runs, and artifacts all write back to portable YAML.

## Quick Start

```bash
npm install
cline-fleet init
cline-fleet doctor
cline-fleet studio
```

Open:

```text
http://127.0.0.1:3127
```

The default run is read-only:

```bash
cline-fleet run --dry-run "Inspect this repo and propose a plan"
cline-fleet run "Inspect this repo and propose a plan"
```

Implementation is explicit:

```bash
cline-fleet run --implement "Refactor the auth middleware safely"
```

## Concepts

- **Models** live in `models.yaml`: provider, base URL, model ID, modalities, context window, output budget, reasoning level, and API key env var.
- **Agents** live in `agents.yaml`: name, role preset, runtime, model, profile, prompt file, phase, and permissions.
- **Pipelines** live in `pipelines.yaml`: ordered phases, parallel/sequential mode, context inputs, compaction, and output limits.
- **Prompts** live in `prompts/*.md`: editable per-agent instructions.
- **Runs** write to `.cline-runs/<timestamp>/`: manifest, logs, phase outputs, diff, and summary.

## CLI

```bash
cline-fleet init [--force] [--source legacy-script]
cline-fleet validate
cline-fleet doctor [--json]
cline-fleet roles
cline-fleet models
cline-fleet pipelines
cline-fleet runtimes
cline-fleet run [--dry-run] [--implement] [--worktree] [--cwd DIR] "task"
cline-fleet runs [--project DIR] [run-id] [file]
cline-fleet studio [--host 127.0.0.1] [--port 3127]
```

## Safety Defaults

- The default pipeline uses read-only planning behavior.
- Code-writing agents only run when `--implement` is set or a custom write pipeline is selected.
- Write phases require a write-capable runtime. Direct API workers are read-only by design.
- Model modality gates prevent image-dependent tasks from silently using text-only models.
- Doctor checks runtimes, profile settings, endpoint reachability, and model ID mismatches before you burn time on a run.

## Worker Runtimes

- `cline`: default, stable, write-capable, MCP/profile-aware.
- `claude-code`: headless Claude Code worker when `claude` auth is configured.
- `codex`: Codex CLI worker for non-interactive planning, review, and implementation.
- `openai-compatible-direct`: direct `/chat/completions` worker for read-only roles.
- `custom-command`: advanced adapter that receives prompt/context on stdin.
- `aider`: detected and available as experimental.

## Publishing Notes

Before publishing, replace local absolute paths in any checked-in examples with generic paths, keep API keys in env vars only, and do not commit `.cline-runs/`, `.cline-models/`, or personal config.
