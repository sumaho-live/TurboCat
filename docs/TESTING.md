# Testing TurboCat

TurboCat uses the VS Code extension testing harness (Mocha + Chai) that runs against the compiled bundle in `out/`.

## Test Commands
- `npm run compile` – required before running tests so the webpack bundle reflects the latest TypeScript sources.
- `npm test` – launches the VS Code test runner using the files under `src/test/suite/`.
- `npm run coverage` – generates an lcov report via `nyc` (optional, slower).

## Recommended Scenarios

| Area | Suggested Coverage |
| --- | --- |
| Tomcat service | Port validation, lifecycle transitions, reload fallbacks |
| Builder service | Project structure detection, build command selection, smart deploy batching |
| Logger service | Prefix formatting, raw log passthrough, configuration reload |
| Toolbar service | Visibility toggles when Tomcat starts/stops, smart deploy colouring |

## Writing Tests
- Mock VS Code APIs with `sinon` and update the import paths to `src/services/*`.
- Use dependency injection where practical (e.g., stub `exec`, `fs`, or `glob`).
- Keep log assertions tolerant—only assert on prefixes or keywords, not full strings with timestamps.

## Manual Verification Checklist
1. `TurboCat: Start` / `TurboCat: Stop` transitions update the toolbar.
2. Deploying a Maven or Gradle project picks the right build without prompting after the first run.
3. The **TurboCat** output channel shows prefixed extension messages and raw Tomcat logs.
4. Smart deploy toggling changes the icon colour immediately.

Document any gaps or planned test additions so they can be tracked in upcoming iterations.
