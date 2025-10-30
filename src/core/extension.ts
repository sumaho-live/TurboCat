/**
 * TurboCat Extension Main Entry Point
 * Manages Tomcat server lifecycle, commands, and configuration
 */

import * as vscode from 'vscode';
import { addSyntaxColoringRules } from '../utils/syntax';
import { Builder } from '../services/Builder';
import { Tomcat } from '../services/Tomcat';
import { Logger } from '../services/Logger';
import { Toolbar } from '../services/Toolbar';
import { DebugProfile } from '../services/DebugProfile';
import iconv from 'iconv-lite';

/**
 * Extension activation - initializes services and registers commands
 */
export function activate(context: vscode.ExtensionContext) {
    const builder = Builder.getInstance();
    const tomcat = Tomcat.getInstance();
    builder.ensureLocalConfigTemplate().catch(error => {
        Logger.getInstance().debug(`Local config template setup skipped: ${error}`);
    });
    // Initialize the Tomcat toolbar
    const toolbar = Toolbar.getInstance();
    toolbar.init();
    
    // Add the toolbar to disposables to ensure proper cleanup
    context.subscriptions.push({
        dispose: () => toolbar.dispose()
    });

    addSyntaxColoringRules();

    context.subscriptions.push(
        vscode.commands.registerCommand('turbocat.start', () => tomcat.start(true)),
        vscode.commands.registerCommand('turbocat.stop', () => tomcat.stop(true)),
        vscode.commands.registerCommand('turbocat.clean', () => tomcat.clean()),
        vscode.commands.registerCommand('turbocat.deploy', () => builder.deploy('Choice')),
        vscode.commands.registerCommand('turbocat.startDebug', () => tomcat.startDebug(true)),
        vscode.commands.registerCommand('turbocat.reload', () => tomcat.reload()),
        vscode.commands.registerCommand('turbocat.toggleSmartDeploy', async () => {
            const currentMode = vscode.workspace.getConfiguration().get<string>('turbocat.smartDeploy', 'Disable');
            const newMode = currentMode === 'Smart' ? 'Disable' : 'Smart';
            
            await vscode.workspace.getConfiguration().update('turbocat.smartDeploy', newMode, true);
            Logger.getInstance().info(`Smart Deploy: ${newMode === 'Smart' ? 'Enabled' : 'Disabled'}`, true);
            
            if (newMode === 'Smart') {
                builder.initializeSmartDeploy();
            } else {
                builder.disposeSmartDeploy();
            }
        }),

        // Debug commands for troubleshooting smart deployment
        vscode.commands.registerCommand('turbocat.debugSmartDeploy', () => builder.debugSmartDeploymentStatus()),
        vscode.commands.registerCommand('turbocat.testCompiledWatcher', () => builder.testCompiledFileWatcher()),
        vscode.commands.registerCommand('turbocat.generateDebugProfile', () => DebugProfile.getInstance().generateJavaAttachProfile()),

        // Configuration change listener with efficient filtering
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('turbocat')) {
                updateSettings(event);
            }
        })
    );

    const debugAttachProvider = vscode.debug.registerDebugConfigurationProvider('java', {
        async resolveDebugConfiguration(_folder, debugConfiguration) {
            const profileName = DebugProfile.getInstance().getAttachProfileName();
            const isTurboCatAttach = typeof debugConfiguration?.name === 'string' &&
                debugConfiguration.name === profileName &&
                debugConfiguration.request === 'attach';

            if (!isTurboCatAttach) {
                return debugConfiguration;
            }

            try {
                const prepared = await tomcat.ensureDebugModeActive(false);
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

    if (Builder.isJavaEEProject()) {
        Logger.getInstance().init();

        context.subscriptions.push(
            vscode.workspace.onWillSaveTextDocument((e) => {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const selectedProjectPath = workspaceFolders[0].uri.fsPath;
                    if (e.document.uri.fsPath.startsWith(selectedProjectPath)) {
                        builder.autoDeploy(e.reason);
                    }
                }
            })
        );
        
        // Initialize smart deploy if configured
        const smartDeploy = vscode.workspace.getConfiguration().get<string>('turbocat.smartDeploy');
        if (smartDeploy === 'Smart') {
            builder.initializeSmartDeploy();
        }
    }
}

/**
 * Extension deactivation - cleanup resources
 */
export function deactivate() {
    Tomcat.getInstance().deactivate();
    Logger.getInstance().deactivate();
    Builder.getInstance().disposeSmartDeploy();
}

/**
 * Handle configuration changes and update services accordingly
 */
function updateSettings(event: vscode.ConfigurationChangeEvent) {
    if (event.affectsConfiguration('turbocat.home')) {
        Tomcat.getInstance().findTomcatHome();
        Builder.getInstance().updateConfig();
        Toolbar.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.javaHome')) {
        Tomcat.getInstance().findJavaHome();
        Builder.getInstance().updateConfig();
        Toolbar.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.port') ||
        event.affectsConfiguration('turbocat.shutdownPort') ||
        event.affectsConfiguration('turbocat.debugPort')) {
        Tomcat.getInstance().updateConfig();
        Tomcat.getInstance().updatePort();
        Toolbar.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.smartDeploy')) {
        const mode = vscode.workspace.getConfiguration().get<string>('turbocat.smartDeploy');
        if (mode === 'Smart') {
            Builder.getInstance().initializeSmartDeploy();
        } else {
            Builder.getInstance().disposeSmartDeploy();
        }
        Toolbar.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.tomcatEnvironment')) {
        Tomcat.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.deployPath')) {
        Tomcat.getInstance().updateConfig();
        Builder.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.preferredBuildType') ||
        event.affectsConfiguration('turbocat.syncBypassPatterns')) {
        Builder.getInstance().updateConfig();

    } else if (event.affectsConfiguration('turbocat.showTimestamp') ||
        event.affectsConfiguration('turbocat.logLevel') ||
        event.affectsConfiguration('turbocat.autoShowOutput')) {
        Logger.getInstance().updateConfig();
        
    } else if (event.affectsConfiguration('turbocat.logEncoding') ||
        event.affectsConfiguration('turbocat.logEncodingCustom')) {
        const configuration = vscode.workspace.getConfiguration();
        const custom = (configuration.get<string>('turbocat.logEncodingCustom', '') ?? '').trim();
        let effective = custom || configuration.get<string>('turbocat.logEncoding', 'utf8');

        if (effective && !iconv.encodingExists(effective)) {
            Logger.getInstance().warn(`Unsupported encoding '${effective}' detected. Falling back to utf8.`);
            if (custom) {
                configuration.update('turbocat.logEncodingCustom', '', true);
                effective = configuration.get<string>('turbocat.logEncoding', 'utf8');
            } else {
                configuration.update('turbocat.logEncoding', 'utf8', true);
                effective = 'utf8';
            }
        }

        Logger.getInstance().updateConfig();
    } else if (event.affectsConfiguration('turbocat.compileEncoding')) {
        Builder.getInstance().updateConfig();
    }
}
