import * as vscode from 'vscode';
import * as path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';

interface LaunchConfigurationFile {
    version?: string;
    configurations?: Array<Record<string, unknown>>;
}

export class DebugProfile {
    private static instance: DebugProfile;
    private readonly configName = 'Attach to Tomcat (TurboCat)';

    public static getInstance(): DebugProfile {
        if (!DebugProfile.instance) {
            DebugProfile.instance = new DebugProfile();
        }
        return DebugProfile.instance;
    }

    public async generateJavaAttachProfile(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('TurboCat: No workspace folder found. Open a Java project first.');
            return;
        }

        const debugPort = vscode.workspace.getConfiguration('turbocat').get<number>('debugPort', 8000);
        const vscodeDir = path.join(workspaceRoot, '.vscode');
        const launchPath = path.join(vscodeDir, 'launch.json');

        try {
            await fsp.mkdir(vscodeDir, { recursive: true });
        } catch (error) {
            vscode.window.showErrorMessage(`TurboCat: Failed to create .vscode directory: ${error}`);
            return;
        }

        let launchConfig: LaunchConfigurationFile = {
            version: '0.2.0',
            configurations: []
        };
        let existingText = '';

        if (fs.existsSync(launchPath)) {
            try {
                existingText = await fsp.readFile(launchPath, 'utf8');
                const stripped = this.stripJsonComments(existingText);
                if (stripped.trim()) {
                    launchConfig = JSON.parse(stripped) as LaunchConfigurationFile;
                }
            } catch (error) {
                vscode.window.showErrorMessage(`TurboCat: Unable to parse .vscode/launch.json. Fix the file manually before retrying.\n${error}`);
                return;
            }
        }

        if (!Array.isArray(launchConfig.configurations)) {
            launchConfig.configurations = [];
        }
        launchConfig.version = launchConfig.version || '0.2.0';

        const existingProfile = launchConfig.configurations.find(config =>
            typeof config === 'object' &&
            config !== null &&
            (config as Record<string, unknown>).name === this.configName &&
            (config as Record<string, unknown>).type === 'java'
        ) as Record<string, unknown> | undefined;

        const desiredProfile = {
            type: 'java',
            name: this.configName,
            request: 'attach',
            hostName: 'localhost',
            port: debugPort
        };

        let message: string;
        if (existingProfile) {
            const profile = existingProfile as Record<string, unknown>;
            profile['hostName'] = 'localhost';
            profile['port'] = debugPort;
            message = 'TurboCat updated the Java attach profile in .vscode/launch.json.';
        } else {
            launchConfig.configurations.push(desiredProfile as unknown as Record<string, unknown>);
            message = 'TurboCat created a Java attach profile in .vscode/launch.json.';
        }

        const formatted = JSON.stringify(launchConfig, null, 2) + '\n';
        if (formatted !== existingText) {
            await fsp.writeFile(launchPath, formatted, 'utf8');
        }

        vscode.window.showInformationMessage(message, 'Open launch.json').then(selection => {
            if (selection) {
                vscode.workspace.openTextDocument(launchPath).then(doc => vscode.window.showTextDocument(doc));
            }
        });
    }

    private stripJsonComments(text: string): string {
        return text
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
    }
}
