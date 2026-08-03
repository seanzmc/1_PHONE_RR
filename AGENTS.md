# PhoneUp Agent Guidance

`CLAUDE.md` owns the project domain, architecture, security, operational, and validation rules. Read it before substantive work and preserve those boundaries. This file adds execution-budget rules for every agent working in this repository.

## Bounded workflow

- Default to one inline worker and one independently useful implementation slice per task.
- Do not propose or use subagent-driven development, parallel agents, per-task reviewers, or continuous multi-plan execution unless the user's original request explicitly requires parallel agents.
- Do not automatically move from a specification into implementation, from one numbered plan into the next, or from local verification into deployment.
- Use focused tests during implementation. After the slice is complete, run the affected package checks. Run the complete workspace suite at most once at final integration.
- Use browser verification only for changed user flows. Preflight the fixture first, retain successful evidence, and do not repeat already-passing cases.
- Allow one review and one fix round. Stop after two repeated failures, fixture problems, or no-progress attempts and report the exact blocker.
- Do not poll agents or background processes through repeated model turns. Wait deterministically or return a checkpoint.
- At 30 minutes, substantial context growth, or unexpected scope expansion, stop with a recoverable checkpoint: completed, validation, blocked, and next.
- Default to medium reasoning. Reserve a single high-reasoning review for a concrete unresolved concurrency, authentication, security, migration, or data-integrity risk. Never select ultra automatically.

## Validation ladder

1. Run the smallest test that proves the changed behavior.
2. Run affected package typecheck or build only when relevant.
3. Run one broader suite after the bounded slice is complete.
4. Keep authenticated browser, deployment, and production verification as separate explicit gates; do not infer them from unit tests.

Do not duplicate exact commands from `CLAUDE.md`, package scripts, or the runbook here. Inspect the current command surface before running it.
