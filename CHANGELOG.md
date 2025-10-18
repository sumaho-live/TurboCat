# Changelog

All notable changes to this project will be documented in this file.

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
