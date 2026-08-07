No core rotation-correctness work remains open. Sections A–K of `next-design-pass.md` are implemented or deliberately superseded. The genuinely open work is UI refinement, one deferred feature, and two operational verifications.

## Open now

Highest-value UI work:

- Assignment result guidance: the card still omits the customer/time, and duplicate-number, unassigned-lead, and empty “Next Up” states lack actionable next steps. [AssignScreen.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AssignScreen.tsx:351)
- Known server errors still pass through raw outside Login. Void, activity, staff, user, note, metric, and reassignment errors have no shared user-facing translation layer. [AssignScreen.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AssignScreen.tsx:215)

Remaining page-level polish:

- Staff List: bulk actions remain undiscoverable until a checkbox is selected; recurring-day-off guidance is minimal. [StaffList.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/StaffList.tsx:360)
- Import Activity: “0 unless manually corrected,” “Unmatched names,” and “Manual rows preserved” remain cryptic; successful deactivation provides no Staff List next step. [ActivityImport.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/ActivityImport.tsx:337)
- Users: rename “Reset password”/“Set manually,” improve the initial-password hint, and replace “Set name” with non-affordance copy. Sort state and repeated row controls also need specific accessible names. [UserManagement.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/UserManagement.tsx:198)
- Team Dashboard: metric definitions and the rep-name drill-in hint remain incomplete. [Dashboard.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/Dashboard.tsx:50)
- Rep Detail: improve empty-state copy and note placeholder; reset “Copied”; only report success after the clipboard write resolves and show failure otherwise. [RepDetail.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/RepDetail.tsx:165)
- Change Password: voluntary changes still navigate away without confirmation; strength guidance remains optional polish. [ChangePassword.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/ChangePassword.tsx:24)
- Audit Log: normal event cards expose raw primary-entity and rep-reference UUIDs even when account,
  rep, and lead records have legible identifiers. [AuditLog.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AuditLog.tsx:303)

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
