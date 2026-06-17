import * as vscode from 'vscode';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export class TomcatBase {
    private static instance: TomcatBase;
    private readonly defaultRelativeBase = path.join('.vscode', 'turbocat');

    public static getInstance(): TomcatBase {
        if (!TomcatBase.instance) {
            TomcatBase.instance = new TomcatBase();
        }
        return TomcatBase.instance;
    }

    public isWorkspaceBaseEnabled(): boolean {
        return vscode.workspace.getConfiguration().get<boolean>('turbocat.useWorkspaceTomcatBase', true);
    }

    public getConfiguredRelativePath(): string {
        const configured = vscode.workspace.getConfiguration()
            .get<string>('turbocat.workspaceTomcatBasePath', this.defaultRelativeBase);
        const trimmed = (configured || this.defaultRelativeBase).trim();
        return trimmed || this.defaultRelativeBase;
    }

    public getWorkspaceBasePath(): string | null {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return null;
        }

        const configuredPath = this.getConfiguredRelativePath();
        if (path.isAbsolute(configuredPath)) {
            return path.normalize(configuredPath);
        }

        return path.join(workspaceRoot, configuredPath);
    }

    public async resolveCatalinaBase(tomcatHome: string): Promise<string> {
        if (!this.isWorkspaceBaseEnabled()) {
            return tomcatHome;
        }

        const workspaceBase = this.getWorkspaceBasePath();
        if (!workspaceBase) {
            return tomcatHome;
        }

        await this.ensureWorkspaceBase(tomcatHome, workspaceBase);
        return workspaceBase;
    }

    public async initializeWorkspaceBase(tomcatHome: string): Promise<string> {
        const workspaceBase = this.getWorkspaceBasePath();
        if (!workspaceBase) {
            throw new Error('No workspace folder found');
        }

        await this.ensureWorkspaceBase(tomcatHome, workspaceBase);
        return workspaceBase;
    }

    private async ensureWorkspaceBase(tomcatHome: string, workspaceBase: string): Promise<void> {
        await Promise.all([
            fsp.mkdir(path.join(workspaceBase, 'conf'), { recursive: true }),
            fsp.mkdir(path.join(workspaceBase, 'logs'), { recursive: true }),
            fsp.mkdir(path.join(workspaceBase, 'temp'), { recursive: true }),
            fsp.mkdir(path.join(workspaceBase, 'work'), { recursive: true }),
            fsp.mkdir(path.join(workspaceBase, 'webapps'), { recursive: true })
        ]);

        await this.copyMissingConfigFiles(path.join(tomcatHome, 'conf'), path.join(workspaceBase, 'conf'));
    }

    private async copyMissingConfigFiles(sourceConf: string, targetConf: string): Promise<void> {
        if (!fs.existsSync(sourceConf)) {
            throw new Error(`Tomcat conf directory not found: ${sourceConf}`);
        }

        const entries = await fsp.readdir(sourceConf, { withFileTypes: true });
        for (const entry of entries) {
            const sourcePath = path.join(sourceConf, entry.name);
            const targetPath = path.join(targetConf, entry.name);

            if (fs.existsSync(targetPath)) {
                continue;
            }

            if (entry.isDirectory()) {
                await this.copyDirectory(sourcePath, targetPath);
            } else if (entry.isFile()) {
                await fsp.copyFile(sourcePath, targetPath);
            }
        }
    }

    private async copyDirectory(source: string, target: string): Promise<void> {
        await fsp.mkdir(target, { recursive: true });
        const entries = await fsp.readdir(source, { withFileTypes: true });

        for (const entry of entries) {
            const sourcePath = path.join(source, entry.name);
            const targetPath = path.join(target, entry.name);
            if (entry.isDirectory()) {
                await this.copyDirectory(sourcePath, targetPath);
            } else if (entry.isFile()) {
                await fsp.copyFile(sourcePath, targetPath);
            }
        }
    }
}
