# TurboCat End-to-End Test Guide

Use this guide to verify TurboCat in a real VS Code, JDK, Tomcat, and Java web project environment.

## Prerequisites
- VS Code with the local TurboCat extension installed or running through the extension host.
- JDK 8+ installed.
- Apache Tomcat installed locally.
- One Java web project. Maven WAR is the easiest first target.
- Optional: a second Java web project to verify workspace isolation.

Before testing, record these paths:

```text
JDK home:
Tomcat home:
Project A:
Project B:
```

## Extension Setup
1. Open the Java web project in VS Code.
2. Open Settings and configure:
   - `turbocat.home` = your Tomcat installation path.
   - `turbocat.javaHome` = your JDK path.
   - `turbocat.useWorkspaceTomcatBase` = `true`.
   - `turbocat.workspaceTomcatBasePath` = `.vscode/turbocat`.
3. Run `TurboCat: Initialize Workspace Tomcat Config`.
4. Confirm these folders exist:

```text
.vscode/turbocat/conf
.vscode/turbocat/logs
.vscode/turbocat/temp
.vscode/turbocat/work
.vscode/turbocat/webapps
```

5. Confirm `.vscode/turbocat/conf/server.xml` exists.
6. Confirm your global Tomcat install still has its original `conf/server.xml`.

Expected result: TurboCat created a workspace-local Tomcat base without replacing the global Tomcat install.

## Workspace Config Isolation
1. In VS Code settings for Project A, set:
   - `turbocat.port` = `8088`
   - `turbocat.shutdownPort` = `8008`
2. Run `TurboCat: Start`.
3. Inspect `.vscode/turbocat/conf/server.xml`.
4. Confirm it contains the new HTTP and shutdown ports.
5. Inspect `<tomcatHome>/conf/server.xml`.

Expected result:
- Workspace `server.xml` changed.
- Global Tomcat `server.xml` did not change.
- Tomcat starts on `http://localhost:8088`.

## Basic Lifecycle
1. Run `TurboCat: Start`.
2. Open the TurboCat output channel.
3. Confirm startup messages appear.
4. Visit `http://localhost:<turbocat.port>`.
5. Run `TurboCat: Stop`.
6. Refresh the browser page.

Expected result:
- Tomcat starts successfully.
- TurboCat output shows runtime logs.
- After stop, the server is no longer reachable.

## Maven Deployment
Use a Maven WAR project with `pom.xml` and `<packaging>war</packaging>`.

1. Set `turbocat.preferredBuildType` = `Maven`.
2. Run `TurboCat: Deploy`.
3. Confirm Maven build completes.
4. Confirm deployment appears under:

```text
.vscode/turbocat/webapps/<appName>
```

5. Visit:

```text
http://localhost:<turbocat.port>/<appName>
```

Expected result:
- The webapp is deployed under the workspace Tomcat base.
- Nothing is deployed into `<tomcatHome>/webapps`, unless workspace base is disabled.

## Deploy Path Override
1. Set:
   - `turbocat.deployPath` = `custom-app`
2. Run `TurboCat: Deploy`.
3. Confirm output/deployment path:

```text
.vscode/turbocat/webapps/custom-app
```

4. Visit:

```text
http://localhost:<turbocat.port>/custom-app
```

Expected result: TurboCat uses the configured workspace-local webapp name.

## Clean
1. Confirm the app exists under `.vscode/turbocat/webapps/<appName>`.
2. Run `TurboCat: Clean`.
3. Confirm the app directory was removed.
4. Confirm matching runtime cache under `.vscode/turbocat/work` or `.vscode/turbocat/temp` was cleaned when present.

Expected result: cleanup affects the workspace base, not the global Tomcat install.

## Logs
1. Run `TurboCat: Start`.
2. Open the app in a browser a few times.
3. Check:

```text
.vscode/turbocat/logs
```

4. Open the TurboCat output channel.

Expected result:
- Tomcat logs are written under the workspace base.
- TurboCat output streams runtime logs.

## Smart Deploy
1. Set:
   - `turbocat.smartDeploy` = `Smart`
2. Run `TurboCat: Deploy` once.
3. Edit a static resource, such as a JSP, HTML, CSS, or JS file.
4. Save the file.
5. Confirm the changed file is copied into `.vscode/turbocat/webapps/<appName>`.
6. Change and rebuild a Java class so a `.class` file updates.
7. Confirm the class is copied into:

```text
.vscode/turbocat/webapps/<appName>/WEB-INF/classes
```

8. Delete a watched static resource or compiled class.
9. Confirm the deployed copy is removed.

Expected result: Smart Deploy synchronizes create/change/delete events into the workspace-local deployment.

## Debug Profile
1. Run `TurboCat: Generate Java Debug Profile`.
2. Confirm `.vscode/launch.json` contains `Attach to Tomcat (TurboCat)`.
3. Run that debug configuration.
4. If Tomcat is stopped or running normally, let TurboCat prepare debug mode.

Expected result:
- Tomcat starts or restarts in debug mode.
- VS Code attaches to `turbocat.debugPort`.

## Two-Project Isolation
Use Project A and Project B with the same global Tomcat installation.

1. In Project A:
   - `turbocat.port` = `8088`
   - `turbocat.shutdownPort` = `8008`
   - Run `TurboCat: Initialize Workspace Tomcat Config`.
2. In Project B:
   - `turbocat.port` = `8099`
   - `turbocat.shutdownPort` = `8009`
   - Run `TurboCat: Initialize Workspace Tomcat Config`.
3. Compare:

```text
Project A/.vscode/turbocat/conf/server.xml
Project B/.vscode/turbocat/conf/server.xml
<tomcatHome>/conf/server.xml
```

Expected result:
- Project A and Project B have independent config.
- The global Tomcat config remains unchanged.
- Only one Tomcat instance should run at a time unless you intentionally configure non-conflicting ports and separate runtime bases.

## Global Tomcat Mode
1. Set `turbocat.useWorkspaceTomcatBase` = `false`.
2. Run `TurboCat: Start`.
3. Run `TurboCat: Deploy`.
4. Inspect `<tomcatHome>/webapps` and `<tomcatHome>/conf/server.xml`.

Expected result: TurboCat behaves like the older global Tomcat model and uses the Tomcat installation directory directly.

## Failure Notes To Capture
When something fails, record:
- OS and architecture.
- VS Code version.
- JDK version.
- Tomcat version.
- Project type: Maven, Gradle, Eclipse/local.
- `turbocat.*` settings used.
- TurboCat output channel contents.
- Whether `.vscode/turbocat/conf/server.xml` exists.
- Whether the global Tomcat config was unexpectedly modified.

## Pass Criteria
The feature passes E2E when:
- Workspace base is created correctly.
- Tomcat starts with workspace-local config.
- Port changes modify workspace `server.xml`, not global `server.xml`.
- Deploy/clean/logs use `.vscode/turbocat`.
- Smart Deploy syncs changes and deletes deployed copies.
- Two projects can keep different Tomcat config using one shared Tomcat install.
