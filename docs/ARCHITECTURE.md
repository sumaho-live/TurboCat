# TurboCat Architecture

The TurboCat extension is organised around a small set of singleton services that collaborate through the activation entry point in `src/core/extension.ts`.

## Module Map

```
src/
├─ core/
│  └─ extension.ts        # Extension activation / deactivation, command registration
├─ services/
│  ├─ Tomcat.ts           # Tomcat lifecycle, configuration, and manager API integration
│  ├─ Builder.ts          # Deployment orchestration and smart deploy watchers
│  ├─ Logger.ts           # Unified logging stream and Tomcat log watchers
│  ├─ Toolbar.ts          # Status-bar controls driven by Tomcat state
│  └─ DebugProfile.ts     # Guided generation of VS Code launch configurations
└─ utils/
   └─ syntax.ts           # Output channel syntax colouring rules
```

All services follow the singleton pattern (`getInstance()`) to ensure there is a single source of truth for workspace configuration and runtime state.

## Responsibilities

### Tomcat Service
- Discovers and validates Tomcat/JDK locations.
- Launches, stops, cleans, and reloads the server.
- Updates `server.xml` on port changes and writes back to workspace settings.
- Streams Tomcat process output to the logger.

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

### Logger Service
- Maintains a single VS Code Output channel (`TurboCat`).
- Prefixes extension logs with `【turbocat】[LEVEL]` while streaming Tomcat output untouched.
- Watches the Tomcat `logs/` directory and tails new access logs without reformatting.
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

## Activation Flow
1. `activate()` instantiates the services and registers commands.
2. The toolbar initialises and starts polling server state.
3. Syntax colouring rules are merged into the workspace.
4. Configuration change listeners propagate updates to the relevant services.
5. When the extension is deactivated the services gracefully stop watchers and processes.

This structure keeps the extension modular, testable, and easy to extend with additional workflows.
