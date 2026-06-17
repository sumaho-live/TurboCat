# TurboCat Architecture

The TurboCat extension is organised around a small set of singleton services that collaborate through the activation entry point in `src/core/extension.ts`.

## Module Map

```
src/
├─ core/
│  └─ extension.ts        # Extension activation / deactivation, command registration
├─ services/
│  ├─ Tomcat.ts           # Tomcat lifecycle, configuration, and manager API integration
│  ├─ TomcatBase.ts       # Workspace-local CATALINA_BASE creation and config isolation
│  ├─ Builder.ts          # Deployment orchestration and smart deploy watchers
│  ├─ Logger.ts           # Unified logging stream and Tomcat log watchers
│  ├─ Toolbar.ts          # Status-bar controls driven by Tomcat state
│  └─ DebugProfile.ts     # Guided generation of VS Code launch configurations
└─ utils/
   ├─ deploymentPath.ts   # Shared deployment path normalisation
   └─ syntax.ts           # Output channel syntax colouring rules
```

All services follow the singleton pattern (`getInstance()`) to ensure there is a single source of truth for workspace configuration and runtime state.

## Responsibilities

### Tomcat Service
- Discovers and validates Tomcat/JDK locations.
- Launches, stops, cleans, and reloads the server.
- Updates `server.xml` on port changes and writes back to workspace settings.
- Uses a workspace-local `CATALINA_BASE` when `turbocat.useWorkspaceTomcatBase` is enabled.
- Streams Tomcat process output to the logger.
- Respects the workspace-level `turbocat.deployPath` override when resolving the active webapp.
- Waits for start/stop transitions to finish so reloads never collide with lingering JVMs.
- Exposes helpers to restart Tomcat in debug mode on demand before VS Code attaches.

### TomcatBase Service
- Resolves the workspace Tomcat base path from `turbocat.workspaceTomcatBasePath`.
- Creates `conf`, `logs`, `temp`, `work`, and `webapps` under the workspace base.
- Copies missing config files from the shared Tomcat installation without overwriting project-specific files.
- Lets the shared Tomcat installation remain `CATALINA_HOME` while the project runtime directory becomes `CATALINA_BASE`.

### Builder Service
- Detects project structure (Maven / Gradle / local) and remembers explicit overrides.
- Executes the correct deployment flow:
  - Maven – `mvn clean package`.
  - Gradle – `gradlew war`.
  - Local – `javac` compilation + file synchronisation.
- Runs dual smart deploy watchers:
  - Static resources (`src/**/*`) deploy immediately.
  - Compiled classes (`target/classes`, `build/classes`, etc.) are batched before syncing.
- Coordinates batch reload decisions and maps file changes to Tomcat destinations.
- Deploys to the effective runtime `webapps` directory, which is workspace-local by default.
- Normalises the configured deployment directory (`turbocat.deployPath`) before generating targets.

### Logger Service
- Maintains a single VS Code Output channel (`TurboCat`).
- Prefixes extension logs with `[TurboCat][LEVEL]` while streaming Tomcat output untouched.
- Respects `turbocat.showSmartDeployLog` to hide Smart Deploy info/debug output (warnings and errors still surface).
- Watches the effective runtime `logs/` directory and tails new access logs without reformatting.
- Exposes helper methods (`info`, `success`, `warn`, `error`, `appendRawLine`) used by other services.

### Toolbar Service
- Creates status-bar buttons for start/stop/debug/deploy/reload/clean/smart deploy.
- Polls the Tomcat service to determine which buttons should be visible at any moment.
- Shows explicit `Smart Deploy` / `Smart Deploy (Off)` states for clarity.
- Disposes resources cleanly on deactivation.

### DebugProfile Service
- Generates or updates `.vscode/launch.json` with a Java attach configuration.
- Aligns the attach port with the current `turbocat.debugPort` setting.
- Opens the resulting file on demand so developers can review or tweak settings.
- Shares the default attach profile name with the extension so debug sessions can auto-start Tomcat in debug mode.

## Activation Flow
1. `activate()` instantiates the services and registers commands.
2. The toolbar initialises and starts polling server state.
3. Syntax colouring rules are merged into the workspace.
4. Configuration change listeners propagate updates to the relevant services.
5. Tomcat start/deploy flows resolve the effective runtime base before editing config or writing deployment artifacts.
6. When the extension is deactivated the services gracefully stop watchers and processes.

This structure keeps the extension modular, testable, and easy to extend with additional workflows.
