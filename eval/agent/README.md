# Agent evals

`oce eval` measures what the retrieval engine *finds*; these tasks measure
what the agent *does*. A prompt tweak, tool change, or provider swap can leave
retrieval metrics untouched while quietly breaking the agent's ability to
finish a job — this suite is the canary for that.

## Running

```bash
oce eval-agent --tasks eval/agent/tasks.json -p <provider> --llm-model <model> [--only fix-failing-test]
```

Needs an LLM (any provider `oce agent` speaks). Each task runs in its own
throwaway workspace with a fresh index; grading is a verification command
(`node _verify.js`) whose exit code decides pass/fail. `--keep` preserves the
workspaces, `--json` emits the full report.

## Task format

```json
{
  "id": "fix-failing-test",
  "instruction": "what the agent is told",
  "files": { "calc.js": "…seed contents…", "_verify.js": "grader" },
  "verify": { "command": "node _verify.js" },
  "allowShell": false,
  "timeoutMs": 300000
}
```

- `files` seed the workspace; `_verify.js` is the grader and ships with the
  task (the agent may read it — spec-by-test is how real work happens).
- `verify.command` runs with the workspace as cwd; exit 0 passes. Keep
  commands shell-portable — `node <file>` is the canonical form.
- Shell access is off by default: tasks should be solvable with
  read/search/edit, and shell makes grading noisy.

## The suite

| id | exercises |
|---|---|
| `fix-failing-test` | localizing and fixing an off-by-one under a spec |
| `create-module` | writing a new module to an exact behavioral contract |
| `rename-symbol` | consistent multi-file refactor, no stragglers |
| `delete-dead-code` | removal without breaking the live path |
| `add-endpoint` | extending an existing pattern in place |
| `test-driven-feature` | reading a test file as the spec; injectable-clock design; pass/fail under a real test suite |
| `cross-file-dependency` | callback→promise refactor across a module and two call sites, error paths preserved |
| `precision-edit` | fixing one behavior while an unrelated output contract and a minimal-diff constraint hold |

The suite runs nightly in CI (`.github/workflows/nightly.yml`): retrieval evals
always, agent tasks whenever an `OCE_NIGHTLY_LLM_KEY` secret is configured.

## Adding a task

Keep it deterministic (no network, no clocks), small enough for one sitting,
and graded by behavior rather than diff-matching — the point is that the job
got done, not that the edit looks like yours. The runner itself is
model-agnostic (`src/eval/agent-runner.ts` takes an injected agent), which is
what lets its own tests run without an LLM.
