# Testing TurboCat

TurboCat uses the VS Code extension testing harness (Mocha + Chai) that runs against the compiled bundle in `out/`.

## Test Commands
- `npm run compile` – builds the production webpack bundle at `out/extension.js`.
- `npm run compile-tests` – compiles `src/test/suite/*.ts` and service dependencies into `out/test/suite/`.
- `npm test` – compiles the extension, compiles tests, lints, and launches the VS Code test runner through `scripts/run-tests.js`.
- `npm run coverage` – generates an lcov report via `nyc` (optional, slower).

## Recommended Scenarios

| Area | Suggested Coverage |
| --- | --- |
| Tomcat service | Port validation, lifecycle transitions, reload fallbacks |
| TomcatBase service | Workspace base creation, config preservation, fallback behavior |
| Builder service | Project structure detection, build command selection, smart deploy batching |
| Logger service | Prefix formatting, raw log passthrough, configuration reload |
| Toolbar service | Visibility toggles when Tomcat starts/stops, smart deploy colouring |
| DebugProfile service | Launch.json generation, port updates, error handling when JSON is invalid |

For real-environment validation, follow the end-to-end checklist in `docs/E2E_TESTING.md`.

## Writing Tests
- Mock VS Code APIs with `sinon` and import current service modules from `src/services/*`.
- Use dependency injection where practical (e.g., stub `exec`, `fs`, or `glob`).
- Keep log assertions tolerant—only assert on prefixes or keywords, not full strings with timestamps.

## Manual Verification Checklist
1. `TurboCat: Start` / `TurboCat: Stop` transitions update the toolbar.
2. Deploying a Maven or Gradle project picks the right build without prompting after the first run.
3. The **TurboCat** output channel shows prefixed extension messages and raw Tomcat logs.
4. Smart deploy toggling reflects the correct label (`Smart Deploy` / `Smart Deploy (Off)`).
5. `TurboCat: Generate Java Debug Profile` creates or updates `.vscode/launch.json` with the configured debug port.

Document any gaps or planned test additions so they can be tracked in upcoming iterations.
