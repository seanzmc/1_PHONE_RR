Work in:

/Users/seandm/Projects/1_PHONE_RR

Goal:

Update docs/ui-critique_07-31.md with an independent frontend UI/UX review conducted by your own reviewers.

This is a report-only task. Do not modify application code, dependencies, tests, configuration, database data, or deployment state. Do not commit, push, or deploy.

Operating context:

- Read AGENTS.md if present, then README.md, CLAUDE.md, and the relevant frontend source.
- The application’s critical job is assigning the correct next sales rep in a couple of seconds.
- Respect the existing four-role model: ADMIN, MANAGER, BDC, and REP.
- Respect the v1 scope and explicitly identify suggestions that would be out of scope.
- The design-system source is under design-system/_ds/.
- The implemented frontend is under apps/web/.
- The existing critique already emphasizes copy, errors, empty states, and dead ends. Your review should independently test those conclusions while looking harder at visual hierarchy, interaction design, accessibility, responsiveness, role-specific workflows, and operational usability.

Use the orchestrator to run three independent review tracks:

1. Visual and interaction review
   - Layout, hierarchy, density, spacing, typography, contrast, affordances, navigation, tables, forms, cards, badges, modals, and feedback.
   - Review realistic desktop widths, especially the dealership workstation experience.
   - Check approximately 1440px and 1024px widths.
   - Check a narrow viewport around 390px, but remember that a full mobile rep experience is explicitly outside v1 scope. Report narrow-screen defects accurately without turning mobile expansion into a launch requirement.

2. Workflow and role review
   - Review ADMIN, MANAGER, BDC, and REP experiences independently.
   - Evaluate Login, forced and voluntary password change, Assign, My Dashboard/Rep Detail, Staff List, Team Dashboard, Import Activity, Users, Audit Log, profile navigation, and admin “View as.”
   - Follow the critical BDC flow from receiving a phone call through assignment, copying the number, handling warnings, voiding mistakes, and recovering from failures.
   - Evaluate loading, empty, success, warning, validation, permission, disabled, stale-data, and network-failure states.
   - Identify dead ends and places where the UI does not explain the next action.

3. Accessibility and implementation-evidence review
   - Inspect semantic HTML, labeling, keyboard navigation, focus order and visibility, modal behavior, live-region needs, touch-target sizing, autocomplete, input modes, table usability, and status communication that relies on color.
   - Trace findings to the current React components, shared UI components, tokens, styles, contracts, and server messages.
   - Use exact current file and line references wherever possible.
   - Do not infer behavior from names alone; follow the actual runtime path.

Independence requirement:

- Each reviewer should make their first-pass notes without reading the conclusions already written in docs/ui-critique_07-31.md.
- After those notes are complete, compare them with the existing critique.
- Do not manufacture “new” findings merely to differ from the existing reviewer.
- Mark agreement as confirmation and reserve “net-new” for materially distinct findings.

Browser verification:

- Prefer inspecting the rendered local application with realistic seeded data and each available role.
- Use only a local development database or other clearly disposable fixture data.
- Do not write to or test destructive workflows against production.
- If the application cannot be rendered, continue with a source-backed review but disclose exactly which browser, viewport, role, or state checks were not completed.
- Do not claim a screen or behavior was visually verified unless it was actually rendered and exercised.

Document update:

- Preserve the existing critique and its findings.
- Correct the document’s top date from “2024-07-31” to “2026-07-31” if that is still the current typo.
- Append a new section titled:

  ## Hermes Orchestrator Independent Review — 2026-07-31

Use this structure:

### Method and coverage
Briefly state what was inspected, which roles and viewports were rendered, and any limitations.

### Confirmed findings
Cross-reference existing item numbers. Explain what independent evidence confirmed each one without restating the entire original finding.

### Net-new findings
Rank findings by:
- P0: prevents or corrupts the core assignment workflow
- P1: serious dead end, misleading state, or accessibility barrier
- P2: recurring usability or comprehension problem
- P3: visual polish

For every finding include:
- Screen and affected role
- State or viewport where observed
- Exact file/line or rendered evidence
- What happens now
- User impact
- Smallest appropriate recommendation
- Confidence: high, medium, or low

Only include concrete findings supported by current repository or rendered evidence. Do not invent bugs.

### Visual-system observations
Assess whether the implemented UI consistently follows the design-system source, including typography, color ramps, spacing, controls, navigation, density, and responsive behavior.

### Strengths to preserve
Call out effective patterns that future changes should not accidentally degrade.

### Consolidated priority order
Produce one deduplicated top-five sequence combining the original critique and the independent review. Optimize for:
1. correct and fast assignment,
2. eliminating misleading or unrecoverable states,
3. role clarity,
4. accessibility,
5. visual polish.

### Verification limitations
State anything that was source-inspected but not browser-verified.

Important boundaries:

- Do not implement any recommendation.
- Do not rewrite the original reviewer’s voice or silently delete findings.
- Do not broaden this into a redesign, architecture proposal, or new product roadmap.
- Do not recommend a UI framework or dependency unless current capabilities demonstrably cannot solve the issue.
- Keep recommendations proportional to this single-team internal tool.
- Avoid duplicate findings and generic advice.
- Finish by showing the exact diff for docs/ui-critique_07-31.md and summarize:
  - confirmed existing findings,
  - net-new findings,
  - checks actually performed,
  - remaining verification gaps.