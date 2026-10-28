import * as vscode from 'vscode';
import { Logger } from './Logger';
import { getWorkspaceConfiguration } from '../core/workspace';

const JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug';

/**
 * Attaches the VS Code Java debugger to a project's Tomcat after TurboCat
 * starts it in debug mode, controlled by `turbocat.debugAutoAttach`.
 */
export class DebugAttacher implements vscode.Disposable {
    private readonly sessions = new Set<vscode.DebugSession>();
    private readonly disposables: vscode.Disposable[];

    public constructor() {
        this.disposables = [
            vscode.debug.onDidStartDebugSession(session => this.sessions.add(session)),
            vscode.debug.onDidTerminateDebugSession(session => this.sessions.delete(session))
        ];
    }

    public isEnabled(folder: vscode.WorkspaceFolder): boolean {
        return getWorkspaceConfiguration('turbocat', folder.uri).get<boolean>('debugAutoAttach', true);
    }

    /** Attach to `port` unless disabled or a Java debugger is already attached to it. */
    public async attach(folder: vscode.WorkspaceFolder, port: number): Promise<boolean> {
        if (!this.isEnabled(folder)) {
            return false;
        }

        const logger = Logger.getInstance(folder.uri);
        if (this.isAttached(port)) {
            logger.debug(`Java debugger already attached to port ${port}`);
            return true;
        }

        if (!vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID)) {
            logger.warn(
                `Cannot attach the debugger automatically: install "Debugger for Java" (${JAVA_DEBUG_EXTENSION_ID}), or set turbocat.debugAutoAttach to false.`,
                true
            );
            return false;
        }

        const configuration: vscode.DebugConfiguration = {
            type: 'java',
            name: `TurboCat: ${folder.name}`,
            request: 'attach',
            hostName: 'localhost',
            port
        };

        try {
            const started = await vscode.debug.startDebugging(folder, configuration);
            if (started) {
                logger.info(`Java debugger attached to port ${port}`);
            } else {
                logger.warn(`Java debugger could not attach to port ${port}`, true);
            }
            return started;
        } catch (error) {
            logger.error(`Java debugger could not attach to port ${port}`, true, error instanceof Error ? error : String(error));
            return false;
        }
    }

    private isAttached(port: number): boolean {
        for (const session of this.sessions) {
            const configuration = session.configuration;
            if (session.type === 'java' && configuration.request === 'attach' && Number(configuration.port) === port) {
                return true;
            }
        }
        return false;
    }

    public dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.sessions.clear();
    }
}
