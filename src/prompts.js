import fs from "node:fs";
import { agentPromptPath, getModel } from "./config.js";
import { readText } from "./util.js";

const PHASE_RULES = {
  recon: [
    "READ ONLY.",
    "Inspect the repo and produce concise markdown.",
    "Include relevant files/modules, existing conventions, tests/build commands, correctness risks, edge cases, and what not to touch."
  ],
  compact: [
    "Compact upstream reports from stdin into a high-signal context pack.",
    "Remove duplicates, preserve exact file paths/commands/symbols/uncertainty, and keep blockers and risks."
  ],
  plan: [
    "Create a production-grade implementation plan from stdin.",
    "Include assumptions, target files, staged steps, correctness risks, validation commands, rollback notes, and non-goals."
  ],
  implement: [
    "Implement the plan from stdin.",
    "Make minimal scoped changes, preserve public behavior unless explicitly changed, avoid broad refactors, and run relevant tests when possible."
  ],
  review: [
    "Review the supplied plan, diff, or implementation summary.",
    "Severity-rank correctness bugs, regressions, security/production risks, missing tests, edge cases, and operational concerns."
  ],
  final: [
    "Synthesize upstream reports into a decisive final report.",
    "Include must-fix issues, should-fix issues, likely false positives, safety-to-commit, exact next commands, PR summary, and rollback notes."
  ]
};

export function buildSystemPrompt({ config, agent, phase }) {
  const model = getModel(config, agent.model);
  const customPath = agentPromptPath(agent);
  const custom = customPath && fs.existsSync(customPath) ? readText(customPath).trim() : "";
  const rules = PHASE_RULES[phase.name] || [`Complete the assigned phase: ${phase.name}.`];
  const readOnly = phase.readOnly ? ["Do not edit source files."] : [];
  const budget = [
    `Output budget: keep the answer under approximately ${phase.maxOutputWords || model.outputBudget || 2000} words.`,
    `Model capability note: modalities=${(model.modalities || ["text"]).join(", ")}, contextWindow=${model.contextWindow || "unknown"}.`
  ];

  return [
    `You are ${agent.name}: ${agent.role}.`,
    ...readOnly,
    ...rules,
    ...budget,
    custom ? "\nCustom agent instructions:\n" + custom : ""
  ].filter(Boolean).join("\n");
}

export function buildUserPrompt({ task, agent, phase }) {
  return [
    `Task:\n${task}`,
    "",
    `Agent: ${agent.name}`,
    `Phase: ${phase.name}`,
    "",
    "Use stdin context if provided. Return concise markdown that satisfies the phase contract."
  ].join("\n");
}

export function inferRequiredModalities(task, explicit = []) {
  const required = new Set(["text", ...explicit]);
  if (/(image|screenshot|photo|picture|diagram|visual|vision|multimodal|multi-modal)/i.test(task)) {
    required.add("image");
  }
  return [...required];
}

export function assertModalities({ config, pipeline, required }) {
  const errors = [];
  for (const phase of pipeline.phases || []) {
    if (phase.type === "diff") continue;
    for (const agentName of phase.agents || []) {
      const agent = config.agents.find((item) => item.name === agentName);
      const model = agent && config.models[agent.model];
      if (!agent || !model) continue;
      const modalities = new Set(model.modalities || ["text"]);
      for (const modality of required) {
        if (!modalities.has(modality)) {
          errors.push(`${phase.name}/${agent.name} uses ${agent.model}, which lacks required modality: ${modality}`);
        }
      }
    }
  }
  if (errors.length) {
    throw new Error(`Modality gate failed:\n${errors.join("\n")}`);
  }
}
