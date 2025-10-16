# Development Guide

This document captures the day-to-day workflow for hacking on TurboCat.

## Prerequisites
- Node.js 18+ (use `nvm install 18 && nvm use 18` if needed)
- npm v9+ (bundled with Node 18)
- VS Code Extension tools: `npm install -g @vscode/vsce`
- A local Tomcat distribution for manual testing

## First-Time Setup
```bash
git clone <repository-url>
cd trubo-cat
npm install
```

## Build & Run
- **Compile once**: `npm run compile`
- **Watch mode**: `npm run watch`
- **Package vsix**: `npm run package`

Launch the extension host from VS Code (`F5` / "Run Extension") to test changes interactively.

## Project Layout
```
src/
├─ core/extension.ts      # Activation entry point
├─ services/              # Singleton services (Tomcat, Builder, Logger, Toolbar, DebugProfile)
├─ utils/syntax.ts        # Output channel colouring rules
└─ test/suite/            # Mocha test harness (to be updated alongside service changes)
docs/                     # Documentation
out/                      # Compiled webpack bundle
```

## Coding Guidelines
- Favour the existing singleton services for shared state.
- Keep asynchronous flows resilient: catch/handle errors and surface them through the logger.
- When introducing new status-bar or command behaviour, route changes via `Toolbar`/`extension.ts`.
- Prefer updating documentation (`README.md` and `docs/`) alongside feature work.

## Useful Commands
- `npm run lint` – ESLint over `src/`.
- `npm test` – Runs the VS Code test runner (update mocks in `src/test/suite` if APIs change).
- `vsce package` – Builds a distributable `.vsix` after `npm run compile`.

## Filing Follow-Up Work
Capture open questions or required follow-ups in `docs/TODO.md` (create if necessary) or the issue tracker so they are not lost between iterations.
