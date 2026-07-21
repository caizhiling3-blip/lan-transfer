# AGENTS.md

## Project constraints

- Follow the numbered development stages documented in `docs/development.md`.
- Do not implement features from later stages without explicit user approval.
- Keep TypeScript strict and do not use `any`.
- Shared protocol, IPC, error, and transfer types belong in `src/shared`; do not duplicate them.
- The renderer must not import Electron or Node.js APIs.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Explain every new dependency before adding it.
- Update the relevant documentation when behavior, architecture, protocol, or configuration changes.
- Before finishing a stage, run typecheck, lint, build, and tests when a test script exists.
- Do not commit, push, rewrite Git history, or delete untracked files without explicit permission.
