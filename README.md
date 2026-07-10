# TurboCat – Apache Tomcat Extension for VS Code

TurboCat keeps Apache Tomcat development inside Visual Studio Code fast and predictable. It auto-detects your project layout, applies the right deployment strategy, and gives every workspace its own Tomcat runtime base so `server.xml`, logs, temp files, work files, and deployed apps stay isolated.

## Highlights
- **Smart synchronization** – dual watchers keep static resources and compiled classes in sync with Tomcat, now with configurable filename bypass rules for temporary “copy” artifacts.
- **Guided automation** – one-click commands start, stop, clean, or reload Tomcat and generate Java debug profiles when you need them.
- **Tomcat config isolation** – every workspace can use its own `CATALINA_BASE`, keeping `server.xml`, logs, temp files, work files, and deployed apps separated from other projects.
- **Unified diagnostics** – a single TurboCat output channel streams extension messages and Tomcat logs with consistent formatting.
- **Zero guessing** – automatic detection locates Tomcat, the JDK, ports, and project type so you can stay focused on code.

## Installation
1. Open Visual Studio Code.
2. Navigate to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **TurboCat** and click **Install**.

## Daily Workflow
- `TurboCat: Start` – boots Tomcat (debug mode available via `TurboCat: Start in Debug Mode`).
- `TurboCat: Stop` – sends Tomcat's shutdown command first and force-terminates lingering JVMs when needed.
- `TurboCat: Deploy` – detects Maven/Gradle/local layouts and keeps Tomcat in sync with the matching deployment pipeline.
- `TurboCat: Clean` – removes the active webapp deployment and its cached work/temp artifacts.
- `TurboCat: Reload` – reloads the active context or restarts when necessary, waiting for Tomcat to shut down cleanly before coming back up.
- `TurboCat: Generate Java Debug Profile` – scaffolds `.vscode/launch.json` and keeps the attach port aligned with TurboCat settings.
- `TurboCat: Initialize Workspace Tomcat Config` – creates or refreshes the project-local Tomcat base used for isolated runtime config.

The status-bar toolbar hides actions that are not relevant to the current server state. When Tomcat is stopped you only see start/debug/deploy. Once the server is running the toolbar collapses to stop/reload/clean plus the smart deploy toggle. The Smart Deploy button now shows `Smart Deploy` or `Smart Deploy (Off)` so you can see the mode at a glance.

## Configuration Snapshot
All settings live under the `turbocat.*` namespace. Key options:

| Setting | Purpose | Notes |
| --- | --- | --- |
| `turbocat.home` / `turbocat.javaHome` | Optional overrides for discovery | Takes priority over system `JAVA_HOME`; prompted on first launch if left blank |
| `turbocat.port` / `turbocat.debugPort` | Server & debug ports | Validated and written back to Tomcat configuration |
| `turbocat.shutdownPort` | Tomcat shutdown socket | Must differ from the HTTP port; updates server.xml and restarts on demand |
| `turbocat.smartDeploy` | `Disable` or `Smart` | Enables dual-watcher deployment |
| `turbocat.smartDeployDebounce` | Batch delay for compiled classes | Default 300 ms |
| `turbocat.syncBypassPatterns` | Filename keywords to skip syncing | Comma-separated list, default catches “copy” variants |
| `turbocat.showSmartDeployLog` | Toggle smart deploy info/debug logs | Defaults to true; set false to suppress automatic sync chatter |
| `turbocat.logEncoding` | Tomcat log decoding | Accepts any iconv-lite encoding name, such as `shift_jis` or `gb18030` |
| `turbocat.preferredBuildType` | Forced build pipeline | Auto by default; set to Local/Maven/Gradle to skip prompts |
| `turbocat.deployPath` | Override Tomcat webapp directory name | Relative to `webapps/`; leave empty to use the workspace folder name |
| `turbocat.tomcatBase` | Project `CATALINA_BASE` | Defaults to `.vscode/turbocat`; set to an empty string to use `CATALINA_HOME` directly |
| `turbocat.tomcatEnvironment` | Environment variables for standard starts | JSON object of key/value pairs applied to normal `TurboCat: Start` runs |
| `turbocat.tomcatDebugEnvironment` | Debug-only environment overrides | Applied exclusively to `TurboCat: Start in Debug Mode`, leaving normal starts untouched |

## Tomcat Config Isolation

TurboCat uses your configured Tomcat installation as `CATALINA_HOME`, but by default creates a project-local `CATALINA_BASE` at `.vscode/turbocat`. That means each workspace gets its own mutable runtime state while still sharing the same Tomcat installation:

```text
.vscode/turbocat/
├─ conf/
├─ logs/
├─ temp/
├─ work/
└─ webapps/
```

On first use, TurboCat copies missing files from `<tomcatHome>/conf` into `.vscode/turbocat/conf` and preserves files that already exist. Port updates, deployments, clean operations, and log watching all use the workspace base, so one project can change `server.xml` or deploy a webapp without affecting another project that shares the same Tomcat install.

Set `turbocat.tomcatBase` to an empty string to use the Tomcat installation directory directly.

## Multi-project workspaces

TurboCat creates an independent runtime for every VS Code Workspace Folder. Each project owns its Tomcat process record, Builder, file watchers, log channel, ports, and `CATALINA_BASE`. Commands are routed using the active editor, while save events are routed using the saved document's folder. Closing one window or removing one Workspace Folder releases only that project's extension resources and never stops another project's Tomcat.

Project settings use VS Code's native precedence. Configure a value once in User settings, then override the same key in Workspace or Workspace Folder settings when a project needs a different Tomcat, JDK, port, build type, or deployment path. Separate `workspace*` override settings are no longer needed.

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
- Use `turbocat.tomcatDebugEnvironment` for debug-only JVM flags (e.g. enabling remote monitors) while keeping `turbocat.tomcatEnvironment` reserved for standard starts.

## Logging
- All output goes to a single VS Code Output channel named **TurboCat**.
- Extension messages are prefixed with `[TurboCat][LEVEL]` and keep optional timestamps.
- Tomcat logs stream through untouched, including HTTP access logs—no more reformatting. Tomcat server logs are explicitly exempt from extension log level filtering to ensure full visibility.
- Adjust `turbocat.logLevel` to control the verbosity of extension messages; setting to `INFO` will hide background `DEBUG` chatter.
- Extension ports are automatically synchronized with Tomcat's `server.xml` before every start, ensuring your VS Code settings are always applied.
- With workspace isolation enabled, logs are read from `.vscode/turbocat/logs` and port changes are written to `.vscode/turbocat/conf/server.xml`.
- Adjust `turbocat.logEncoding` when Tomcat writes logs in encodings such as Shift_JIS or GBK.
- Set `turbocat.showSmartDeployLog` to `false` if you want to hide Smart Deploy chatter while keeping warnings and errors.

## Getting Help
1. Open the **TurboCat** output channel for immediate diagnostics.
2. Verify `turbocat.home`, `turbocat.javaHome`, and port settings in VS Code.
3. Check the documentation in `docs/` for architecture, development, and testing guidance.

If an issue persists, gather the output channel contents and file a ticket on the project tracker.
