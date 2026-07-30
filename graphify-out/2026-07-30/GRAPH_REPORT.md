# Graph Report - .  (2026-07-30)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 855 nodes · 1592 edges · 79 communities (49 shown, 30 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.87)
- Token cost: 2,158 input · 836 output

## Graph Freshness
- Built from commit: `65852969`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Authentication and Realtime API
- Component Lifecycle and Template Compilation
- Daily Activity Import and Normalization
- Login Throttling and Security
- Shift Scheduling and Eligibility
- Audit and Eligibility Policies
- TypeScript Base Configuration
- API Contracts and Schemas
- TypeScript App Compiler Settings
- Web App Dependencies and Build
- Database Tables and Entities
- API Routers and Input Schemas
- TypeScript Node Compiler Settings
- Lead Assignment and Reconciliation
- Testing and Development Tools
- Password and Roster Utilities
- Lead Assignment Logic and Ranking
- Server Dependencies and Middleware
- Lead Assignment Business Logic
- Core Server and Session Management
- Contracts Package and Validation
- Permissions and Authorization
- Frontend Dev Dependencies and Plugins
- TypeScript Base Compiler Options
- Node Types and Tooling
- Project Package Configuration
- Project Scripts and Maintenance
- API Package and Dev Dependencies
- Project Scripts and Job Automation
- Server Setup and Health Checks
- Activity API and Schemas
- Deployment and Container Configuration
- Database ORM and Core Dependencies
- TypeScript Plugins and Testing
- User Management Testing and Context
- Lead and CRM Business Logic
- Database Package Metadata
- Database Backup and Versioning
- Status Override Functionality
- Linting Rules and Configuration
- Restore Drill and Data Management
- Backup Script and Logging
- WebSocket Mock and Testing
- Web Project TypeScript Config
- Roster Backfill and Parsing
- Database Activity and Day Off Tables
- Fastify Cookie Middleware
- Fastify Multipart Middleware
- Node Cron Scheduling
- WebSocket Library
- Zod Validation Library
- API Testing Configuration
- Database Session Table
- Web App HTML Entry
- Web App Favicon
- Web App Icons
- Web App Documentation
- Web App Hero Image
- React Logo SVG
- Vite Logo SVG
- Round-Robin Project Guidelines
- Stingray Chevrolet Logo
- Industry Design System Docs
- Stingray PhoneUp Base Design
- PhoneUp Round-Robin UI Prototype
- Plant City Dealership Logo
- Design and Repair Notes
- Round-Robin Operations Runbook
- Status Handoff Summary
- GitHub Actions CI Workflow
- PNPM Workspace Setup
- Round-Robin Project README

## God Nodes (most connected - your core abstractions)
1. `DB` - 42 edges
2. `businessDate()` - 29 edges
3. `compilerOptions` - 18 edges
4. `react` - 15 edges
5. `useAuthStore` - 15 edges
6. `compilerOptions` - 15 edges
7. `materializeShifts()` - 13 edges
8. `Phase 1 Core Loop Implementation Plan` - 13 edges
9. `assignLead()` - 12 edges
10. `prepareDailyActivity()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `indexRosterByNormalizedName()` --indirect_call--> `rep()`  [INFERRED]
  apps/api/src/jobs/activityImport.ts → packages/core/src/ranking.test.ts
- `withOnlyEligible()` --calls--> `businessDate()`  [EXTRACTED]
  apps/api/src/domain/voidLead.test.ts → packages/core/src/businessDate.ts
- `assignLead()` --calls--> `businessDate()`  [EXTRACTED]
  apps/api/src/domain/assignLead.ts → packages/core/src/businessDate.ts
- `assignLead()` --calls--> `periodKey()`  [EXTRACTED]
  apps/api/src/domain/assignLead.ts → packages/core/src/businessDate.ts
- `assignLead()` --calls--> `rankReps()`  [EXTRACTED]
  apps/api/src/domain/assignLead.ts → packages/core/src/ranking.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Core Components of Assignment Transaction** — plans_v1_plan_assignment_transaction, plans_v1_plan_ranking_function, plans_v1_plan_eligibility_job [EXTRACTED 1.00]
- **Lead Entry Form Flow** — plans_poe_plan_leadentryform, plans_poe_plan_useassignlead, plans_poe_plan_copyphone [EXTRACTED 1.00]

## Communities (79 total, 30 thin omitted)

### Community 0 - "Authentication and Realtime API"
Cohesion: 0.05
Nodes (75): App(), Page, VIEW_AS_ROLES, handle(), mutate(), query(), BoardSocketHandle, connectBoardSocket() (+67 more)

### Community 1 - "Component Lifecycle and Template Compilation"
Cohesion: 0.07
Nodes (52): boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey(), createComponentFactory(), createExternalModules() (+44 more)

### Community 2 - "Daily Activity Import and Normalization"
Cohesion: 0.09
Nodes (35): csv, path, assertActivityMatchQuality(), businessDateFromFilename(), findUniqueRosterRep(), importDailyActivity(), ImportSummary, indexRosterByNormalizedName() (+27 more)

### Community 3 - "Login Throttling and Security"
Cohesion: 0.12
Nodes (29): Bucket, bucketFor(), buckets, isThrottled(), prune(), recordFailure(), recordSuccess(), resetThrottle() (+21 more)

### Community 4 - "Shift Scheduling and Eligibility"
Cohesion: 0.11
Nodes (24): getRecurringDaysOff(), getUpcomingShifts(), SetDaysOffInput, setRecurringDaysOff(), businessDatesThroughSaturday(), dayOfWeek(), EvaluateInput, evaluateRepEligibility() (+16 more)

### Community 5 - "Audit and Eligibility Policies"
Cohesion: 0.09
Nodes (25): auditEvents, dailyFacts, reactivationRequest, unassignedQueue, eligibilitySnapshot, repDailyActivity, repDailyStatus, repRecurringDayOff (+17 more)

### Community 6 - "TypeScript Base Configuration"
Cohesion: 0.07
Nodes (25): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json, compilerOptions (+17 more)

### Community 7 - "API Contracts and Schemas"
Cohesion: 0.14
Nodes (25): ActivityImportCommitInput, ActivityImportInput, activityImportInputSchema, ActivityImportPreviewInput, AssignLeadInput, assignLeadInputSchema, CreateAccountInput, createAccountInputSchema (+17 more)

### Community 8 - "TypeScript App Compiler Settings"
Cohesion: 0.08
Nodes (23): compilerOptions, allowArbitraryExtensions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection (+15 more)

### Community 9 - "Web App Dependencies and Build"
Cohesion: 0.09
Nodes (22): @phoneup/contracts, @phoneup/contracts, dependencies, @phoneup/contracts, react, react-dom, zustand, name (+14 more)

### Community 10 - "Database Tables and Entities"
Cohesion: 0.09
Nodes (22): "app_user", "assignment_events", "audit_events", "customer", "daily_facts", "eligibility_snapshot", "lead", "lead_activity" (+14 more)

### Community 11 - "API Routers and Input Schemas"
Cohesion: 0.18
Nodes (14): adminRouter, setPolicyInputSchema, assignmentRouter, authRouter, boardRouter, computeRoster(), hashRepIdToSeed(), byRepInputSchema (+6 more)

### Community 12 - "TypeScript Node Compiler Settings"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, noEmit, noFallthroughCasesInSwitch (+11 more)

### Community 13 - "Lead Assignment and Reconciliation"
Cohesion: 0.20
Nodes (9): repIds, repIds, Mismatch, reconcile(), ReconcileResult, scheduleReconciliationJob(), today, days (+1 more)

### Community 14 - "Testing and Development Tools"
Cohesion: 0.12
Nodes (16): fast-check, devDependencies, fast-check, typescript, vitest, vitest, main, name (+8 more)

### Community 15 - "Password and Roster Utilities"
Cohesion: 0.17
Nodes (12): ADJECTIVES, generateTempPassword(), NOUNS, queryClient, hashPassword(), importRoster(), parseRoster(), ROLE_MAP (+4 more)

### Community 16 - "Lead Assignment Logic and Ranking"
Cohesion: 0.23
Nodes (9): hashRepIdToSeed(), nextUpRepId(), repIds, withOnlyEligible(), fmt, periodKey(), rankReps(), RepRankInput (+1 more)

### Community 17 - "Server Dependencies and Middleware"
Cohesion: 0.13
Nodes (15): dependencies, cookie, csv-parse, fastify, @fastify/cors, @fastify/static, @phoneup/db, @trpc/server (+7 more)

### Community 18 - "Lead Assignment Business Logic"
Cohesion: 0.22
Nodes (11): assignLead(), AssignLeadInput, AssignLeadResult, hashRepIdToSeed(), ensureEligibilitySnapshots(), assignOne(), voidLead(), VoidLeadInput (+3 more)

### Community 19 - "Core Server and Session Management"
Cohesion: 0.25
Nodes (8): createSession(), loadSession(), bus, attachRealtimeServer(), authorizeBoardSocket(), BoardSocketAuthorizer, userWithSession(), Phase 1 Core Loop Implementation Plan

### Community 20 - "Contracts Package and Validation"
Cohesion: 0.14
Nodes (13): dependencies, zod, zod, main, name, private, scripts, test (+5 more)

### Community 21 - "Permissions and Authorization"
Cohesion: 0.23
Nodes (8): requireAuth, requirePerm(), fakeReqRes, t, Frontend User Management Implementation Plan, hasPermission(), MATRIX, Permission

### Community 22 - "Frontend Dev Dependencies and Plugins"
Cohesion: 0.15
Nodes (13): devDependencies, oxlint, @types/react, @types/react-dom, vite, @vitejs/plugin-react, vitest, vitest (+5 more)

### Community 23 - "TypeScript Base Compiler Options"
Cohesion: 0.17
Nodes (11): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, resolveJsonModule, skipLibCheck (+3 more)

### Community 24 - "Node Types and Tooling"
Cohesion: 0.17
Nodes (12): @types/node, @types/node, @types/node, drizzle-kit, devDependencies, drizzle-kit, tsx, @types/node (+4 more)

### Community 25 - "Project Package Configuration"
Cohesion: 0.18
Nodes (10): engines, node, name, packageManager, private, scripts, build, dev (+2 more)

### Community 26 - "Project Scripts and Maintenance"
Cohesion: 0.18
Nodes (11): scripts, backfill-display-names, backup, generate, import-roster, migrate, restore-drill, seed (+3 more)

### Community 27 - "API Package and Dev Dependencies"
Cohesion: 0.13
Nodes (14): devDependencies, tsx, @types/node-cron, @types/ws, vitest, tsx, vitest, main (+6 more)

### Community 28 - "Project Scripts and Job Automation"
Cohesion: 0.20
Nodes (10): scripts, dev, import-activity, materialize-shifts, reconcile, rotate-passwords, start, test (+2 more)

### Community 29 - "Server Setup and Health Checks"
Cohesion: 0.22
Nodes (8): AppRouter, __dirname, port, server, webDist, scheduleShiftMaterializationJob(), checkDatabase(), healthQuery

### Community 30 - "Activity API and Schemas"
Cohesion: 0.24
Nodes (6): activityRouter, byRepInputSchema, base, activityImportCommitInputSchema, activityImportPreviewInputSchema, setMetricInputSchema

### Community 31 - "Deployment and Container Configuration"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, healthcheckPath, healthcheckTimeout, restartPolicyMaxRetries, restartPolicyType (+1 more)

### Community 32 - "Database ORM and Core Dependencies"
Cohesion: 0.22
Nodes (9): drizzle-orm, @phoneup/core, drizzle-orm, @phoneup/core, dependencies, drizzle-orm, @phoneup/core, postgres (+1 more)

### Community 33 - "TypeScript Plugins and Testing"
Cohesion: 0.22
Nodes (9): typescript, plugins, typescript, devDependencies, typescript, vitest, vitest, oxc (+1 more)

### Community 34 - "User Management Testing and Context"
Cohesion: 0.33
Nodes (7): adminCaller(), fakeReqRes, fakeSession(), managerCaller(), Context, createContext(), Role

### Community 35 - "Lead and CRM Business Logic"
Cohesion: 0.22
Nodes (9): CopyPhone, LeadEntryForm, useAssignLead, Assignment Transaction, Daily CRM Import Job, Data Model, Daily Eligibility Job, Ranking Function (+1 more)

### Community 36 - "Database Package Metadata"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 37 - "Database Backup and Versioning"
Cohesion: 0.52
Nodes (6): assertDumpVersionIsCompatible(), backup(), majorVersion(), rowCounts(), run, TABLES

### Community 39 - "Status Override Functionality"
Cohesion: 0.47
Nodes (4): overrideStatus(), OverrideStatusInput, STATUS_TO_DAILY_STATUS, upsertOverride()

### Community 40 - "Linting Rules and Configuration"
Cohesion: 0.33
Nodes (5): rules, react/only-export-components, react/rules-of-hooks, $schema, warn

### Community 41 - "Restore Drill and Data Management"
Cohesion: 0.47
Nodes (5): drill(), keep, newestDump(), repoRoot, run

### Community 42 - "Backup Script and Logging"
Cohesion: 0.70
Nodes (4): fail(), log(), PATH, backup-to-drive.sh script

## Knowledge Gaps
- **351 isolated node(s):** `name`, `version`, `private`, `type`, `main` (+346 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `typescript` connect `TypeScript Plugins and Testing` to `Node Types and Tooling`, `Testing and Development Tools`?**
  _High betweenness centrality (0.302) - this node is a cross-community bridge._
- **Why does `plugins` connect `TypeScript Plugins and Testing` to `Linting Rules and Configuration`, `Authentication and Realtime API`?**
  _High betweenness centrality (0.284) - this node is a cross-community bridge._
- **Why does `react` connect `Authentication and Realtime API` to `TypeScript Plugins and Testing`?**
  _High betweenness centrality (0.284) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _351 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Authentication and Realtime API` be split into smaller, more focused modules?**
  _Cohesion score 0.05414141414141414 - nodes in this community are weakly interconnected._
- **Should `Component Lifecycle and Template Compilation` be split into smaller, more focused modules?**
  _Cohesion score 0.0673076923076923 - nodes in this community are weakly interconnected._
- **Should `Daily Activity Import and Normalization` be split into smaller, more focused modules?**
  _Cohesion score 0.09080841638981174 - nodes in this community are weakly interconnected._