No core rotation-correctness work remains open. Sections A–K of `next-design-pass.md` are implemented or deliberately superseded. The genuinely open work is UI refinement, one deferred feature, and two operational verifications.

## Open now

Highest-value UI work:

- Assignment result guidance: the card still omits the customer/time, and duplicate-number, unassigned-lead, and empty “Next Up” states lack actionable next steps. [AssignScreen.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AssignScreen.tsx:351)
- Reactivation requests: the REP dashboard now explains status and says to contact a manager, but the role contract still promises submitting reactivation requests and no request workflow exists. [CLAUDE.md](/Users/seandm/Projects/1_PHONE_RR/CLAUDE.md:35)
- Known server errors still pass through raw outside Login. Void, activity, staff, user, note, metric, and reassignment errors have no shared user-facing translation layer. [AssignScreen.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AssignScreen.tsx:215)
- Navigation/accessibility shell:

  - “My Dashboard” and “Dashboard” remain ambiguous.
  - Active-nav CSS targets `.ui-nav-tab`, which the buttons never receive.
  - The wrapped ADMIN profile menu can still clip offscreen.
  - Primary, muted, and table-header text still miss the documented AA contrast targets.

  [App.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/App.tsx:110) · [ui.css](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/styles/ui.css:94)

Remaining page-level polish:

- Staff List: bulk actions remain undiscoverable until a checkbox is selected; recurring-day-off guidance is minimal. [StaffList.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/StaffList.tsx:360)
- Import Activity: “0 unless manually corrected,” “Unmatched names,” and “Manual rows preserved” remain cryptic; successful deactivation provides no Staff List next step. [ActivityImport.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/ActivityImport.tsx:337)
- Users: rename “Reset password”/“Set manually,” improve the initial-password hint, and replace “Set name” with non-affordance copy. Sort state and repeated row controls also need specific accessible names. [UserManagement.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/UserManagement.tsx:198)
- Team Dashboard: metric definitions and the rep-name drill-in hint remain incomplete. [Dashboard.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/Dashboard.tsx:50)
- Rep Detail: improve empty-state copy and note placeholder; reset “Copied”; only report success after the clipboard write resolves and show failure otherwise. [RepDetail.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/RepDetail.tsx:165)
- Change Password: voluntary changes still navigate away without confirmation; strength guidance remains optional polish. [ChangePassword.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/ChangePassword.tsx:24)
- Audit Log: Before/After creation events still use a vertically centered toolbar and `—` for missing state. [AuditLog.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/pages/AuditLog.tsx:30)
- Design-system fidelity: blueprint registration marks are still absent from cards and primary buttons. [ui/index.tsx](/Users/seandm/Projects/1_PHONE_RR/apps/web/src/ui/index.tsx:28)

## Open from `next-design-pass.md`

- Explicit backlog: “Mark a lead sold” remains intentionally deferred pending the attribution-versus-CRM-total decision. [next-design-pass.md](/Users/seandm/Projects/1_PHONE_RR/docs/next-design-pass.md:137)
- Production display-name backfill: the script and runbook command exist, but I found no repository receipt proving it ran against production. [RUNBOOK.md](/Users/seandm/Projects/1_PHONE_RR/docs/RUNBOOK.md:331)
- Sold-column semantics: the document contradicts itself—section H treats `Sold` as daily, while the appended notes call it cumulative. Current code uses daily values summed monthly; the requested first-real-import verification remains undocumented. [next-design-pass.md](/Users/seandm/Projects/1_PHONE_RR/docs/next-design-pass.md:64)

## Stale—not open

- The old client-only View-as design is superseded by real-profile, server-enforced read-only View-as.
- The multi-day recurring-day-off design is explicitly superseded by one optional Mon–Sat day.
- The SHADOW→ENFORCE automatic-disqualification rollout is superseded by the manager-reviewed import decision. [CLAUDE.md](/Users/seandm/Projects/1_PHONE_RR/CLAUDE.md:30)
- All seven net-new P1 findings added to the critique were subsequently fixed: roster loading, assignment busy state, View-as writes, auth bootstrap, dynamic announcements/page focus, password masking, and the Vite blank page.

Validation: read-only audit; no files changed. Web tests passed `70/70`, production build passed, and lint completed with existing Fast Refresh warnings only. The commands ran under Node 26.5.0 while the repository declares Node 22.x.