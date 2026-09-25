/**
 * TurboCat Extension Main Entry Point
 * Manages Tomcat server lifecycle, commands, and configuration
 */

import * as vscode from 'vscode';
import { Logger } from '../services/Logger';
import { Toolbar } from '../services/Toolbar';
import { DebugProfile } from '../services/DebugProfile';
import iconv from 'iconv-lite';
import { getWorkspaceConfiguration } from './workspace';
import { ProjectRuntime, ProjectRuntimeRegistry } from './ProjectRuntimeRegistry';

let runtimeRegistry: ProjectRuntimeRegistry | undefined;

/**
 * Extension activation - initializes services and registers commands
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        await migrateLegacyWorkspaceConfiguration(folder.uri);
    }
    runtimeRegistry = new ProjectRuntimeRegistry();
    for (const runtime of runtimeRegistry.getAll()) {
        void initializeProjectRuntime(runtime);
    }
    // Initialize the Tomcat toolbar
    const toolbar = Toolbar.getInstance();
    toolbar.init();
    
    // Add the toolbar to disposables to ensure proper cleanup
    context.subscriptions.push({
        dispose: () => toolbar.dispose()
    });



    context.subscriptions.push(
        vscode.commands.registerCommand('turbocat.start', () => runtimeRegistry?.forResource()?.tomcat.start(true)),
        vscode.commands.registerCommand('turbocat.stop', () => runtimeRegistry?.forResource()?.tomcat.stop(true)),
        vscode.commands.registerCommand('turbocat.clean', () => runtimeRegistry?.forResource()?.tomcat.clean()),
        vscode.commands.registerCommand('turbocat.deploy', () => runtimeRegistry?.forResource()?.builder.deploy('Choice')),
        vscode.commands.registerCommand('turbocat.startDebug', () => runtimeRegistry?.forResource()?.tomcat.startDebug(true)),
        vscode.commands.registerCommand('turbocat.reload', () => runtimeRegistry?.forResource()?.tomcat.reload()),
        vscode.commands.registerCommand('turbocat.initializeWorkspaceTomcatBase', () => runtimeRegistry?.forResource()?.tomcat.initializeWorkspaceTomcatBase()),
        vscode.commands.registerCommand('turbocat.toggleSmartDeploy', async () => {
            const runtime = runtimeRegistry?.forResource();
            if (!runtime) {
                return;
            }
            const configuration = getWorkspaceConfiguration('turbocat', runtime.workspaceFolder.uri);
            const currentMode = configuration.get<string>('smartDeploy', 'Disable');
            const newMode = currentMode === 'Smart' ? 'Disable' : 'Smart';
            
            await configuration.update('smartDeploy', newMode, vscode.ConfigurationTarget.WorkspaceFolder);
            Logger.getInstance().info(`Smart Deploy: ${newMode === 'Smart' ? 'Enabled' : 'Disabled'}`, true);
            
            if (newMode === 'Smart') {
                void runtime.builder.initializeSmartDeploy();
            } else {
                runtime.builder.disposeSmartDeploy();
            }
        }),

        vscode.commands.registerCommand('turbocat.generateDebugProfile', () => DebugProfile.getInstance().generateJavaAttachProfile()),

        // Configuration change listener with efficient filtering
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('turbocat')) {
                void updateSettings(event);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(event => {
            for (const folder of event.removed) {
                runtimeRegistry?.remove(folder);
            }
            for (const folder of event.added) {
                const runtime = runtimeRegistry?.getOrCreate(folder);
                if (runtime) {
                    void migrateLegacyWorkspaceConfiguration(folder.uri)
                        .then(() => initializeProjectRuntime(runtime));
                }
            }
        }),
        vscode.workspace.onWillSaveTextDocument(event => {
            void runtimeRegistry?.forResource(event.document.uri)?.builder.autoDeploy(event.reason);
        })
    );

    const debugAttachProvider = vscode.debug.registerDebugConfigurationProvider('java', {
        async resolveDebugConfiguration(folder, debugConfiguration) {
            const profileName = DebugProfile.getInstance().getAttachProfileName();
            const isTurboCatAttach = typeof debugConfiguration?.name === 'string' &&
                debugConfiguration.name === profileName &&
                debugConfiguration.request === 'attach';

            if (!isTurboCatAttach) {
                return debugConfiguration;
            }

            try {
                const tomcat = runtimeRegistry?.forResource(folder?.uri)?.tomcat;
                const prepared = await tomcat?.ensureDebugModeActive(false);
                if (!prepared) {
                    Logger.getInstance().error('TurboCat: Failed to prepare Tomcat for debug attach.', true);
                    return null;
                }
            } catch (error) {
                const detail = error instanceof Error ? error : String(error);
                Logger.getInstance().error('TurboCat: Failed to prepare Tomcat for debug attach.', true, detail);
                return null;
            }

            return debugConfiguration;
        }
    });
    context.subscriptions.push(debugAttachProvider);

}

async function initializeProjectRuntime(runtime: ProjectRuntime): Promise<void> {
    runtime.logger.init();
    await runtime.builder.ensureLocalConfigTemplate().catch(error => {
        Logger.getInstance().debug(`Local config template setup skipped: ${error}`);
    });
    const configuration = getWorkspaceConfiguration('turbocat', runtime.workspaceFolder.uri);
    if (configuration.get<string>('smartDeploy') === 'Smart') {
        await runtime.builder.initializeSmartDeploy();
    }
}

async function migrateLegacyWorkspaceConfiguration(resource: vscode.Uri): Promise<void> {
    const configuration = getWorkspaceConfiguration('turbocat', resource);
    const scopes = [
        { value: 'globalValue', target: vscode.ConfigurationTarget.Global },
        { value: 'workspaceValue', target: vscode.ConfigurationTarget.Workspace },
        { value: 'workspaceFolderValue', target: vscode.ConfigurationTarget.WorkspaceFolder }
    ] as const;

    const migrate = async <T>(legacyKey: string, modernKey: string): Promise<void> => {
        const legacy = configuration.inspect<T>(legacyKey);
        const modern = configuration.inspect<T>(modernKey);
        for (const scope of scopes) {
            const legacyValue = legacy?.[scope.value];
            if (legacyValue !== undefined && modern?.[scope.value] === undefined) {
                await configuration.update(modernKey, legacyValue, scope.target);
            }
            if (legacyValue !== undefined) {
                await configuration.update(legacyKey, undefined, scope.target);
            }
        }
    };

    await migrate<string>('workspaceJavaHome', 'javaHome');
    await migrate<string>('logEncodingCustom', 'logEncoding');
    await migrate<string>('autoDeployBuildType', 'preferredBuildType');

    const enabled = configuration.inspect<boolean>('useWorkspaceTomcatBase');
    const legacyPath = configuration.inspect<string>('workspaceTomcatBasePath');
    const modernBase = configuration.inspect<string>('tomcatBase');
    for (const scope of scopes) {
        const hasLegacy = enabled?.[scope.value] !== undefined || legacyPath?.[scope.value] !== undefined;
        if (hasLegacy && modernBase?.[scope.value] === undefined) {
            const value = enabled?.[scope.value] === false
                ? ''
                : legacyPath?.[scope.value] ?? '.vscode/turbocat';
            await configuration.update('tomcatBase', value, scope.target);
        }
        if (enabled?.[scope.value] !== undefined) {
            await configuration.update('useWorkspaceTomcatBase', undefined, scope.target);
        }
        if (legacyPath?.[scope.value] !== undefined) {
            await configuration.update('workspaceTomcatBasePath', undefined, scope.target);
        }
    }
}

/**
 * Extension deactivation - cleanup resources
 */
export async function deactivate() {
    await runtimeRegistry?.dispose();
    runtimeRegistry = undefined;
    Logger.disposeAll();
}

/**
 * Handle configuration changes and update services accordingly
 */
async function updateSettings(event: vscode.ConfigurationChangeEvent): Promise<void> {
    for (const runtime of runtimeRegistry?.getAll() ?? []) {
        const resource = runtime.workspaceFolder.uri;
        if (!event.affectsConfiguration('turbocat', resource)) {
            continue;
        }

        const configuration = getWorkspaceConfiguration('turbocat', resource);
        const affectsAny = (keys: string[]): boolean =>
            keys.some(key => event.affectsConfiguration(`turbocat.${key}`, resource));
        const portChanged = affectsAny(['port', 'shutdownPort']);
        const tomcatChanged = affectsAny([
            'home', 'javaHome', 'port', 'shutdownPort', 'debugPort', 'deployPath',
            'tomcatBase', 'tomcatEnvironment', 'tomcatDebugEnvironment'
        ]);
        const builderChanged = affectsAny([
            'javaHome', 'mavenHome', 'deployPath', 'tomcatBase', 'preferredBuildType',
            'syncBypassPatterns', 'compileEncoding', 'smartDeployDebounce'
        ]);
        const loggerChanged = affectsAny([
            'home', 'tomcatBase', 'logEncoding', 'logLevel', 'showTimestamp',
            'autoShowOutput', 'showSmartDeployLog'
        ]);

        if (portChanged) {
            await runtime.tomcat.updatePort();
        }
        if (tomcatChanged) {
            runtime.tomcat.updateConfig();
        }
        if (builderChanged) {
            runtime.builder.updateConfig();
        }

        if (event.affectsConfiguration('turbocat.home', resource)) {
            await runtime.tomcat.findTomcatHome();
        }
        if (event.affectsConfiguration('turbocat.javaHome', resource)) {
            await runtime.tomcat.findJavaHome();
        }
        if (event.affectsConfiguration('turbocat.smartDeploy', resource)) {
            if (configuration.get<string>('smartDeploy') === 'Smart') {
                // May wait for the Java language server; don't block other settings
                void runtime.builder.initializeSmartDeploy();
            } else {
                runtime.builder.disposeSmartDeploy();
            }
        }
        if (event.affectsConfiguration('turbocat.logEncoding', resource)) {
            const effective = configuration.get<string>('logEncoding', 'utf8');
            if (effective && !iconv.encodingExists(effective)) {
                runtime.logger.warn(`Unsupported encoding '${effective}' detected. Falling back to utf8.`);
                await configuration.update('logEncoding', 'utf8', vscode.ConfigurationTarget.WorkspaceFolder);
            }
        }
        if (loggerChanged) {
            runtime.logger.updateConfig();
        }
    }
    Toolbar.getInstance().updateConfig();
}
