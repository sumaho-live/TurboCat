# Changelog

All notable changes to this project will be documented in this file.

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
