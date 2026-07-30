# @phoneup/web

React + Vite SPA for PhoneUp Round-Robin. In production the API serves the built output
(`dist/`) from its own origin, so the browser talks to a relative `/trpc` path and there is
no cross-site cookie configuration.

- Local dev: `pnpm dev` from the repo root (Vite on `:5173`, API on `:3000`).
- Setup, deployment and operations: [../../README.md](../../README.md) and
  [../../docs/RUNBOOK.md](../../docs/RUNBOOK.md).
