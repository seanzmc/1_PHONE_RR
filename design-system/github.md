repo: seanzmc/1_PHONE_RR
branch: main

## Last sync
date: 2026-07-29T14:50:36Z

### Updated in this project
- Read the v1 build spec, guardrails (CLAUDE.md) and existing web app source (App.tsx + all 5 page components). The repo's UI is unstyled Vite scaffolding with no real visual design — nothing to pixel-match — so screens were designed fresh in the Industry design system, following the spec's data model, roles/permissions and screen list exactly.
- Built one Design Component covering all 6 v1 screens + login for Stingray Chevrolet (Plant City, FL), branded with the dealership's logo, with a role-based nav and a working clickable prototype (assign/void, staff overrides, reactivation approve/deny, dashboard, admin policy/team/audit).

## Screen map
| Project screen | Repo source |
| --- | --- |
| Login | apps/web/src/pages/Login.tsx |
| Nav shell + role routing | apps/web/src/App.tsx |
| Assign Lead | apps/web/src/pages/AssignScreen.tsx |
| Staff List | apps/web/src/pages/StaffList.tsx |
| Dashboard | apps/web/src/pages/Dashboard.tsx |
| Admin → Team & Roles | apps/web/src/pages/UserManagement.tsx |
| My Status, Reactivation Queue, Admin → Policy/Audit | plans/v1-plan.md §8 (Screens) — not yet implemented in the repo |
