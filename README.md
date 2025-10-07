# TurboCat – Apache Tomcat Extension for VS Code

TurboCat keeps Apache Tomcat development inside Visual Studio Code fast and predictable. The extension auto-detects your project layout, applies the right deployment strategy, and exposes one-click server controls with live feedback.

## Highlights
- **Lifecycle control** – start, stop, clean, reload, and debug Tomcat from either the command palette or a context-aware status-bar toolbar.
- **Smart deploy** – dual file-system watchers handle static assets instantly and batch compiled Java class updates. Project type is detected automatically with optional one-time overrides.
- **Unified logs** – all TurboCat and Tomcat output streams share a single channel, and every extension message is prefixed with `【turbocat】` for quick scanning.
- **Browser automation** – automatically open or refresh Chrome, Edge, Brave, Opera, Firefox, or Safari after deployment with graceful fallbacks.
- **Zero guessing** – the extension locates Tomcat and the JDK, validates ports, and keeps workspace settings in sync.

## Installation
1. Open Visual Studio Code.
2. Navigate to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **TurboCat** and click **Install**.

## Daily Workflow
- `TurboCat: Start` – boots Tomcat (debug mode available via `TurboCat: Start in Debug Mode`).
- `TurboCat: Deploy` – detects Maven/Gradle/local layouts and executes the matching deployment pipeline without repeated prompts.
- `TurboCat: Clean` – clears `webapps`, `temp`, and `work` while honouring protected apps.
- `TurboCat: Reload` – reloads the active context or restarts when necessary.

The status-bar toolbar hides actions that are not relevant to the current server state. When Tomcat is stopped you only see start/debug/deploy. Once the server is running the toolbar collapses to stop/reload/clean plus the smart deploy toggle. The toggle uses icon colour instead of text to reflect its state.

## Configuration Snapshot
All settings live under the `turbocat.*` namespace. Key options:

| Setting | Purpose | Notes |
| --- | --- | --- |
| `turbocat.home` / `turbocat.javaHome` | Optional overrides for discovery | Prompted on first launch if left blank |
| `turbocat.port` / `turbocat.debugPort` | Server & debug ports | Validated and written back to Tomcat configuration |
| `turbocat.smartDeploy` | `Disable` or `Smart` | Enables dual-watcher deployment |
| `turbocat.smartDeployDebounce` | Batch delay for compiled classes | Default 300 ms |
| `turbocat.browser` / `turbocat.autoReloadBrowser` | Browser integration | Uses Chrome DevTools where available |
| `turbocat.autoDeployBuildType` | Legacy fallback for smart deploy | Only used by background file watchers |
| `turbocat.preferredBuildType` | Forced build pipeline | Auto by default; set to Local/Maven/Gradle to skip prompts |

## Project Types
TurboCat autodetects common Java web structures:

- **Maven** (`pom.xml` with WAR packaging) → runs `mvn clean package`.
- **Gradle** (`build.gradle` / `.kts`) → runs the `war` task once and reuses the output.
- **Local / Eclipse-style** (`WebContent`, `src/main/webapp`, or `bin`) → syncs files directly and compiles Java sources with `javac`.

When multiple layouts are detected, TurboCat asks for a single confirmation and persists the answer at the workspace level.

## Logging
- All output goes to a single VS Code Output channel named **TurboCat**.
- Extension messages are prefixed with `【turbocat】[LEVEL]` and keep optional timestamps.
- Tomcat logs stream through untouched, including HTTP access logs—no more reformatting.

## Getting Help
1. Open the **TurboCat** output channel for immediate diagnostics.
2. Verify `turbocat.home`, `turbocat.javaHome`, and port settings in VS Code.
3. Check the documentation in `docs/` for architecture, development, and testing guidance.

If an issue persists, gather the output channel contents and file a ticket on the project tracker.
