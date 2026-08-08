No core rotation-correctness work remains open. Sections A–K of `next-design-pass.md` are implemented or deliberately superseded. The genuinely open work is the remaining UI refinement below, one deferred feature, and two operational verifications.

## Open now

Highest-value UI work:

- Assignment result guidance: the card still omits the customer/time, and duplicate-number, unassigned-lead, and empty “Next Up” states lack actionable next steps. [AssignScreen.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AssignScreen.tsx:351)
- Known server errors still pass through raw outside Login. Void, activity, staff, user, note, metric, and reassignment errors have no shared user-facing translation layer. [AssignScreen.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AssignScreen.tsx:215)

Remaining page-level polish:

- Staff List: bulk actions remain undiscoverable until a checkbox is selected; recurring-day-off guidance is minimal. [StaffList.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/StaffList.tsx:360)
- Users: rename “Reset password”/“Set manually,” improve the initial-password hint, and replace “Set name” with non-affordance copy. Sort state and repeated row controls also need specific accessible names. [UserManagement.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/UserManagement.tsx:198)
- Change Password: voluntary changes still navigate away without confirmation; strength guidance remains optional polish. [ChangePassword.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/ChangePassword.tsx:24)

## Completed locally — Priority 6

- Team Dashboard now shows exact metric definitions and exposes rep drill-down only to effective roles with `rep.view`.
- Rep Detail has actionable empty states, a note placeholder, and non-optimistic clipboard pending, success, failure, timeout, cleanup, and stale-attempt handling.
- Import Activity uses manager-readable missing, unmatched, and corrected summaries and offers Staff List only after a committed nonzero deactivation.
- Audit Log normal cards use readable current-record identities and resolved rep references without UUID fallbacks; Technical details retain exact canonical IDs and raw payloads.

August 8 Priority 6 validation ran under Node 22.22.3 and pnpm 11.17.0. The focused Audit router proof passed `17/17`, the complete web suite passed `190/190` across 26 files, workspace typecheck passed, web lint completed with 59 warnings and 0 errors, and the production build and diff check succeeded. Authenticated local Manager and BDC browser proof at 1024×768 and 390×844 covered the Dashboard, Rep Detail, Import Activity, and Audit Log flows, permissions, focus, readable identities, technical evidence, and responsive containment. Explicit gaps were a REP-role pass, real OS clipboard write, and browser-level zero-count import dash; the BDC permission alternative and unit-level dash proof passed. No deployment or production verification was performed.

## Open from `next-design-pass.md`

- Explicit backlog: “Mark a lead sold” remains intentionally deferred pending the attribution-versus-CRM-total decision. [next-design-pass.md](/Users/seandm/Projects/1_PHONE_RR/docs/next-design-pass.md:137)
- Production display-name backfill: the script and runbook command exist, but I found no repository receipt proving it ran against production. [RUNBOOK.md](/Users/seandm/Projects/1_PHONE_RR/docs/RUNBOOK.md:331)
- Sold-column semantics: the document contradicts itself—section H treats `Sold` as daily, while the appended notes call it cumulative. Current code uses daily values summed monthly; the requested first-real-import verification remains undocumented. [next-design-pass.md](/Users/seandm/Projects/1_PHONE_RR/docs/next-design-pass.md:64)

## Stale—not open

- The old client-only View-as design is superseded by real-profile, server-enforced read-only View-as.
- The multi-day recurring-day-off design is explicitly superseded by one optional Mon–Sat day.
- The SHADOW→ENFORCE automatic-disqualification rollout is superseded by the manager-reviewed import decision. [CLAUDE.md](/Users/seandm/Projects/1_PHONE_RR/CLAUDE.md:30)
- Blueprint registration marks on cards and buttons are intentionally omitted by product preference;
  their absence is not open work.
- All seven net-new P1 findings added to the critique were subsequently fixed: roster loading, assignment busy state, View-as writes, auth bootstrap, dynamic announcements/page focus, password masking, and the Vite blank page.
- Priority 3 navigation is resolved: every role lands on Team Dashboard; only Reps see My Dashboard; Manager+ administrative destinations are grouped under Management; active styling works; both menus stay within the 1024px and 390px viewports; and the documented small-text/action contrast failures now exceed 4.5:1.
- The unimplemented self-service reactivation request is no longer promised by the role or permission contracts. Reps are directed to a Manager or Admin, preserving the existing audited account/status reactivation path.

August 2 Priority 3 validation: App navigation tests passed `10/10`, contract tests passed `9/9`, a clean migrated-and-seeded API run passed `197/197`, all web tests passed `134/134`, and workspace typecheck, web lint, production build, and diff check exited successfully. Local fixture-backed browser proof covered Admin, Manager, and Rep navigation at 1024×768 and 390×844, including Admin profile-menu containment with View as visible; no deployment or production verification was performed. Remaining items outside Priority 3 were not re-audited. The commands ran under Node 26.5.0 while the repository declares Node 22.x.
