# Changelog

All notable changes to this project will be documented in this file.

## [1.5.1]
### Fixed
- **PreBuilt deploy**: replaced fragile `copyDirectorySync` with robust `brutalSync` for class deployment, and added post-copy verification that logs a warning if no class files were deployed.
- **Smart deploy pause/resume visibility**: pause and resume events now log at WARN level so they are always visible regardless of log level configuration.
- **Maven Home**: added `turbocat.mavenHome` setting for specifying the Maven installation path; `mavenDeploy` now uses the absolute `mvn` path when configured.
- **Maven environment**: `mavenDeploy` now injects `MAVEN_HOME` into the subprocess when configured, in addition to `JAVA_HOME`.
- **Smart deploy pause edge case**: fixed a bug where early returns (e.g., missing Tomcat home) would leave smart deploy permanently disabled by wrapping all exit paths in a unified `try/finally`.

## [1.5.0]
### Added
- **Smart deploy pause during manual deploy**: Smart deploy file watchers are now automatically paused when a manual deployment starts, and restored when it finishes — regardless of success, failure, or early exit. Pause/resume events are logged at WARN level so they are always visible.
- **Workspace-level JAVA_HOME**: new `turbocat.workspaceJavaHome` setting (`scope: "window"`) allows per-project JDK overrides. Takes precedence over the machine-level `turbocat.javaHome`.
- **Maven Home configuration**: new `turbocat.mavenHome` setting (`scope: "machine"`) for specifying the Maven installation path. When set, uses `<mavenHome>/bin/mvn` instead of relying on the system PATH.
- **Eclipse WTP support**: `detectProjectStructure` now parses `.settings/org.eclipse.wst.common.component` to extract deployment mappings (web root, source roots, dependency libraries) for Eclipse WTP projects.
- **Smart deploy visibility warning**: when `turbocat.showSmartDeployLog` is `false`, a warning is shown on initialization so users know debug details are hidden.

### Fixed
- **PreBuilt deploy**: replaced fragile `copyDirectorySync` with robust `brutalSync` for class deployment, and added post-copy verification that logs a warning if no class files were deployed.
- **Maven without JAVA_HOME**: `mavenDeploy` now injects `JAVA_HOME` (and `MAVEN_HOME` when configured) into the `mvn` subprocess when the system environment lacks them.
- **Smart deploy log visibility**: when `showSmartDeployLog` is `false`, only `DEBUG` messages are now suppressed; `INFO`-level deployment confirmations remain visible (previously all messages below `WARN` were hidden).
- **Smart deploy pause edge case**: fixed a bug where early returns (e.g., missing Tomcat home or webapps root) would leave smart deploy permanently disabled by ensuring all exit paths go through the unified `try/finally` that restores the previous state.

## [1.4.0]
### Added
- **PreBuilt deployment mode**: new `turbocat.preferredBuildType` option `"PreBuilt"` skips `mvn clean package` and deploys `target/classes` (already compiled by the Java Language Server) + static web resources directly. Ideal when `mvn` is not on PATH or `JAVA_HOME` is not set globally. Appears as a QuickPick choice when `pom.xml` and `target/classes` both exist.

## [1.3.0]
### Fixed
- **Path handling**: Tomcat stop command now uses `spawn` with argument arrays instead of `exec` with space-joined strings, so Tomcat/JDK installations under paths containing spaces (e.g. `C:\Program Files\…`) no longer fail to stop.
- **Path handling**: `javac` compilation during Local deployments now uses `spawn` with `shell: false` instead of a manually-escaped command string, eliminating incorrect backslash-escaping that broke paths with spaces on Windows and doubled backslashes on Unix.
- **Smart deploy**: `globToRegex` now correctly matches files placed directly in the watched root directory (e.g. `src/main/webapp/TestCode.jsp`) by making the `**/` directory portion optional, instead of requiring at least one subdirectory separator.
- **Smart deploy**: `findDirectClassMatches` now derives the Java package from the source file path and restricts the class-file search to that package, preventing identically-named classes from unrelated packages from being deployed.
- **Smart deploy**: `checkAndDeployCompiledClass` now extracts the package from the Java source path and passes it through to `findDirectClassMatches`, wiring the package-aware fix into the production code path.

## [1.2.0]
### Changed
- Emphasised project-local Tomcat configuration isolation in the README and package metadata.
- Updated the extension version to `1.2.0`.

## [1.0.4]
### Fixed
- **Bug**: Extension log level filtering (`turbocat.logLevel`) now works correctly by robustifying configuration reading and level threshold lookup.
- **Bug**: Tomcat HTTP and Debug ports now apply correctly by synchronizing `server.xml` automatically before every start.
- **Bug**: Improved `server.xml` port detection regex to handle spaces and system property placeholders (e.g. `${http.port}`).
- **Requirement**: Tomcat server logs are now explicitly exempt from extension log level filtering, ensuring full server output remains visible regardless of the extension's configured verbosity.

## [1.0.3]
### Fixed
- **Bug**: Configured `turbocat.javaHome` was ignored when starting or debugging Tomcat; the system default `JAVA_HOME` was used instead. The spawned Tomcat process now explicitly sets `JAVA_HOME` and `JRE_HOME` to the user-configured path.

## [1.0.2]
### Fixed
- **Critical**: `Tomcat.kill()` no longer terminates all Java processes; now only kills the tracked PID or the process on the configured port.
- **Critical**: Removed global `editor.tokenColorCustomizations` mutation from `syntax.ts`; syntax coloring should use `configurationDefaults` instead.
- **Critical**: Added missing `await` on recursive `deploy()` call preventing race conditions during retry.
- **Critical**: Fixed `executeTomcatCommand` Promise semantics so `start` resolves after launch instead of waiting for process exit.
- **Critical**: Replaced regex-based `stripJsonComments` with a character-level parser that respects string literals.
- Fixed dual log monitoring conflict in Logger by consolidating to a single real-time watcher with rotation detection.
- Changed `updateSettings` from `else-if` chain to independent `if` blocks so simultaneous config changes are all processed.
- Increased Toolbar server status polling interval from 3s to 5s and added early exit for non-Java projects.
- Simplified Java file change handling from 6 redundant scans to a single delayed check; removed unreliable time-based dependency analysis.
- Added `return` after `reject()` in `executeCommand` to prevent resolve-after-reject.
- Added error logging to `copyDirectorySync` and `brutalSync` instead of silently swallowing errors.
- Improved Maven `artifactId` extraction to exclude `<parent>`, `<dependencies>`, and `<plugins>` blocks.
- Reduced excessive debug logging in `findMatchingMapping` from ~10 lines per call to 2.
- Changed module-level singleton instantiation to lazy getters to avoid initialization order issues.
- Made `deactivate()` async and properly awaits Tomcat shutdown.

### Changed
- Narrowed `activationEvents` to Java EE project markers (`pom.xml`, `build.gradle`, etc.) instead of matching all workspaces.
- Unified `tsconfig.json` `outDir` to `out` to match webpack output.
- Standardized on `pnpm` as the sole package manager; removed `package-lock.json`.
- Unified port range max to 49151 to match `package.json` constraint.
- 'Local' build option is now always available alongside Maven/Gradle.
- Declared `turbocat.reload` command in `package.json` for command palette discoverability.

### Removed
- Deleted `Builder.ts.backup` from source tree.
- Cleaned up compiled test artifacts (`.js`, `.js.map`) from `src/test/suite/`.
- Removed unused fields (`staticResourceDebouncer`, `compiledFileDebouncer`) and commented-out legacy code.

## [1.0.1]
- Added the `turbocat.tomcatDebugEnvironment` setting so debug launches can inject dedicated environment variables without affecting normal starts.
- Updated the Tomcat service to respect the appropriate environment for start/stop flows and documented the new configuration option.

## [0.1.4]
- Expanded Tomcat log decoding with iconv-lite, added more preset encodings, and introduced the `turbocat.logEncodingCustom` override for arbitrary encoding names (e.g. Shift_JIS, GBK) without garbled output.
- Improved the stop command to send Tomcat's shutdown signal first and fall back to targeted process termination on Windows, eliminating lingering ports.
- Added the `turbocat.shutdownPort` setting and server.xml synchronization so shutdown port changes apply on the next Tomcat start without restarting VS Code.
- Updated documentation to cover the new log encoding controls and shutdown port configuration.

## [0.1.3]
- Added the `turbocat.showSmartDeployLog` setting so Smart Deploy info/debug chatter can be hidden while still surfacing warnings and errors.
- Normalised log prefixes to `[TurboCat][LEVEL]` and pushed verbose Smart Deploy output to debug level for a leaner deploy log.
- Local deployments now run inside a progress notification with stage updates for resource sync, compilation, mappings, and library refreshes.
- Documentation refreshed to cover the new logging behaviour and configuration option.

## [0.1.2]
- Ensured stop/reload operations wait for Tomcat to terminate before restarting, preventing lingering processes from causing false "started" messages or reload failures.
- When launching the default VS Code debug profile, TurboCat now restarts Tomcat in debug mode automatically if required.
- Updated user documentation to cover the new lifecycle behaviour and debug workflow.

## [0.1.1]
- Added the workspace-level `turbocat.deployPath` setting to decouple the Tomcat deployment directory from the project folder name.
- Normalised deployment path handling in the Builder and Tomcat services so deploy/clean/smart deploy honour nested directories consistently.
- Documented the new setting in the README and architecture guide.

## [0.1.0]
- Added mapping-based resource synchronization for Local/Eclipse projects so Local deploy and Smart Deploy reuse the same rules.
- Smart deploy now derives compiled output directories from configured mappings, so pointing `source` to `target/classes/**/*.class` stops the background watchers from probing legacy `bin/` folders.
- Documentation refreshed to highlight that class mappings drive watcher paths for Local/Eclipse projects.
- Improved Tomcat running-state detection on Windows by requiring `LISTENING` matches from `netstat -ano`, preventing the toolbar from reporting "running" after the process terminates.

## [0.0.24]
- Fixed the status-bar toolbar falsely showing Tomcat as running when no `turbocat.home` is configured.
- Added workspace `.vscode/tomcat-smart-deploy.json` templates for Local/Eclipse projects with `localDeploy.mappings` entries that synchronize custom folders (e.g., `conf/`) during Local deploys and smart deploy file watching.
- Local deployment now honours these mappings, copying each matching file into the configured webapp destination after compilation.
- Documented the new mapping file workflow and example usage in the README.

## [0.0.23]
- Added the `turbocat.compileEncoding` setting to control the `javac` `-encoding` value during Local deployments (defaults to UTF-8 for cross-platform builds).
- Local deployment compilation now includes project libraries (e.g., `WEB-INF/lib`, `lib/`) on the `javac` classpath so Lombok and Spring annotations resolve without switching to Maven/Gradle builds.

## [0.0.21]
- Prevented `spawn ENAMETOOLONG` errors during Local deployment by invoking `javac` with a generated args file, enabling large Eclipse projects to compile reliably.

## [0.0.20]
- Improved Local deployment to honor detected Eclipse-style project layouts (WebContent/src/bin) without manual directory rewrites.
- Updated Smart Deploy watchers to monitor Eclipse web resources and compiled class folders for immediate/queued synchronization.

## [0.0.19]
- Treated Tomcat start exit code 143 (or SIGTERM signal) as successful during reloads, preventing spurious “Start failed” errors after a restart.

## [0.0.18]
- Added the `TurboCat: Generate Java Debug Profile` command to scaffold or refresh `.vscode/launch.json` with the correct attach settings.
- Introduced the `turbocat.syncBypassPatterns` setting so copied/duplicate files (e.g., containing “copy” or “副本”) are ignored during smart synchronization.
- Updated documentation, metadata, and the extension description to highlight automated synchronization as the core feature.
- Refreshed the project license to credit TurboCat contributors.

## [0.0.17]
- Ensured `Tomcat.start()` and `Tomcat.startDebug()` await the underlying process so startup failures surface immediately.

## [0.0.16]
- Fixed status-bar toolbar issues: Stop button now hides when the server is down and the Smart Deploy toggle shows explicit `ON`/`OFF` states.
- Added README guidance for attaching the VS Code Java debugger to a TurboCat-managed Tomcat instance.
