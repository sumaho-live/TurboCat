# TurboCat – Apache Tomcat Extension for VS Code

TurboCat keeps Apache Tomcat development inside Visual Studio Code fast and predictable. The extension auto-detects your project layout, applies the right deployment strategy, and exposes one-click server controls with live feedback.

## Highlights
- **Smart synchronization** – dual watchers keep static resources and compiled classes in sync with Tomcat, now with configurable filename bypass rules for temporary “copy” artifacts.
- **Guided automation** – one-click commands start, stop, clean, or reload Tomcat and generate Java debug profiles when you need them.
- **Unified diagnostics** – a single TurboCat output channel streams extension messages and Tomcat logs with consistent formatting.
- **Zero guessing** – automatic detection locates Tomcat, the JDK, ports, and project type so you can stay focused on code.

## Installation
1. Open Visual Studio Code.
2. Navigate to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **TurboCat** and click **Install**.

## Daily Workflow
- `TurboCat: Start` – boots Tomcat (debug mode available via `TurboCat: Start in Debug Mode`).
- `TurboCat: Deploy` – detects Maven/Gradle/local layouts and keeps Tomcat in sync with the matching deployment pipeline.
- `TurboCat: Clean` – removes the active webapp deployment and its cached work/temp artifacts.
- `TurboCat: Reload` – reloads the active context or restarts when necessary, waiting for Tomcat to shut down cleanly before coming back up.
- `TurboCat: Generate Java Debug Profile` – scaffolds `.vscode/launch.json` and keeps the attach port aligned with TurboCat settings.

The status-bar toolbar hides actions that are not relevant to the current server state. When Tomcat is stopped you only see start/debug/deploy. Once the server is running the toolbar collapses to stop/reload/clean plus the smart deploy toggle. The Smart Deploy button now shows `Smart Deploy` or `Smart Deploy (Off)` so you can see the mode at a glance.

## Configuration Snapshot
All settings live under the `turbocat.*` namespace. Key options:

| Setting | Purpose | Notes |
| --- | --- | --- |
| `turbocat.home` / `turbocat.javaHome` | Optional overrides for discovery | Prompted on first launch if left blank |
| `turbocat.port` / `turbocat.debugPort` | Server & debug ports | Validated and written back to Tomcat configuration |
| `turbocat.smartDeploy` | `Disable` or `Smart` | Enables dual-watcher deployment |
| `turbocat.smartDeployDebounce` | Batch delay for compiled classes | Default 300 ms |
| `turbocat.syncBypassPatterns` | Filename keywords to skip syncing | Comma-separated list, default catches “copy” variants |
| `turbocat.autoDeployBuildType` | Legacy fallback for smart deploy | Only used by background file watchers |
| `turbocat.preferredBuildType` | Forced build pipeline | Auto by default; set to Local/Maven/Gradle to skip prompts |
| `turbocat.deployPath` | Override Tomcat webapp directory name | Relative to `webapps/`; leave empty to use the workspace folder name |

## Project Types
TurboCat autodetects common Java web structures:

- **Maven** (`pom.xml` with WAR packaging) → runs `mvn clean package`.
- **Gradle** (`build.gradle` / `.kts`) → runs the `war` task once and reuses the output.
- **Local / Eclipse-style** (`WebContent`, `src/main/webapp`, or `bin`) → syncs files directly and compiles Java sources with `javac`; smart deploy now auto-watches `WebContent` assets and the `bin` output.

When multiple layouts are detected, TurboCat asks for a single confirmation and persists the answer at the workspace level.

### Workspace Mapping File

Non-Maven projects gain a project-scoped mapping file at `.vscode/tomcat-smart-deploy.json`. TurboCat generates a template the first time it sees a local/Eclipse layout so you can describe extra resources that should be copied during a Local deploy. These mappings are also consumed by Smart Deploy, so a single change keeps both manual deployments and background sync in agreement.

Example: copy a `conf/` directory into `WEB-INF/classes/conf` every time TurboCat deploys the app:

```json
{
  "localDeploy": {
    "mappings": [
      {
        "description": "Copy conf resources into WEB-INF/classes/conf",
        "source": "conf",
        "destination": "WEB-INF/classes/conf",
        "enabled": true
      }
    ]
  }
}
```

Each mapping uses workspace-relative paths. TurboCat automatically appends `**/*` to directory sources and `{relative}` placeholders to destinations so the directory structure is preserved. Toggle `enabled` to `false` to keep sample entries without activating them.

Mappings that end in `.class` also teach Smart Deploy where to watch for compiled output. For example, setting `"source": "target/classes/**/*.class"` switches all background class sync from the legacy `bin/` folder to Maven’s output automatically.

## Java Debugging
- Run **`TurboCat: Generate Java Debug Profile`** to create or refresh `.vscode/launch.json` with the correct attach configuration.
- Launch the generated **“Attach to Tomcat (TurboCat)”** configuration from VS Code’s Run and Debug panel. TurboCat now checks Tomcat’s status and, when needed, restarts it in debug mode automatically before VS Code attaches.

## Logging
- All output goes to a single VS Code Output channel named **TurboCat**.
- Extension messages are prefixed with `【turbocat】[LEVEL]` and keep optional timestamps.
- Tomcat logs stream through untouched, including HTTP access logs—no more reformatting.

## Getting Help
1. Open the **TurboCat** output channel for immediate diagnostics.
2. Verify `turbocat.home`, `turbocat.javaHome`, and port settings in VS Code.
3. Check the documentation in `docs/` for architecture, development, and testing guidance.

If an issue persists, gather the output channel contents and file a ticket on the project tracker.
