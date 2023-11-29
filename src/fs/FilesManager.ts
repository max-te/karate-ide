import { addFeature, reloadFeature, reloadKarateTestsController, removeFeature } from '@/execution/KarateTestsManager';
import * as fs from 'fs';
import * as minimatch from 'minimatch';
import * as path from 'path';
import * as vscode from 'vscode';

export class KarateTestTreeEntry {
    uri: vscode.Uri;
    type: vscode.FileType;
    title: string;
    children: KarateTestTreeEntry[];
    constructor(partial: Partial<KarateTestTreeEntry>) {
        Object.assign(this, partial);
    }
}

class FilesManager {
    private workspaceFolders = vscode.workspace.workspaceFolders;
    private workspaceFsPaths: string[];
    private testsGlobFilter: string;
    private classpathFolders: string[];
    private cachedKarateTestFiles: string[];
    private cachedClasspathFiles: string[];
    private watcher: vscode.FileSystemWatcher;

    constructor() {
        this.workspaceFsPaths = this.workspaceFolders && this.workspaceFolders.map(f => f.uri.fsPath);

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('karateIDE.tests.globFilter') || e.affectsConfiguration('karateIDE.karateCli.classpath')) {
                this.loadFiles();
            }
        });

        this.loadFiles();
    }

    public loadFiles = async () => {
        this.testsGlobFilter = String(vscode.workspace.getConfiguration('karateIDE.tests').get('globFilter'));

        this.cachedKarateTestFiles = (await vscode.workspace.findFiles(this.testsGlobFilter))
            .map(f => this.relativeToWorkspace(f.fsPath))
            .map(f => f.replace(/\\/g, '/'));

        this.cachedClasspathFiles = [];
        this.classpathFolders = [];
        const classpathFolders = String(vscode.workspace.getConfiguration('karateIDE.karateCli').get('classpath')).split(/[;:]/g);
        const rootModuleMarkerFile = String(vscode.workspace.getConfiguration('karateIDE.multimodule').get('rootModuleMarkerFile'));
        const moduleRootFolders = await vscode.workspace.findFiles('**/' + rootModuleMarkerFile);
        if (moduleRootFolders.length === 0 && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            moduleRootFolders.push(...vscode.workspace.workspaceFolders.map(f => f.uri));
        }
        this.classpathFolders = moduleRootFolders.flatMap(root => {
            return classpathFolders.map(f => this.relativeToWorkspace(f)).map(f => f.replace(/\\/g, '/'));
        });

        this.classpathFolders.forEach(async classpathFolder => {
            const entries = (await vscode.workspace.findFiles('**/' + classpathFolder + '/**/*.{feature,yml,json}'))
                .map(f => vscode.workspace.asRelativePath(f, false))
                .map(f => path.relative(classpathFolder, f))
                .map(f => f.replace(/\\/g, '/'));
            this.cachedClasspathFiles.push(...entries);
        });

        reloadKarateTestsController();
        this.watch();
    };

    private watch() {
        this.watcher && this.watcher.dispose();
        this.watcher = vscode.workspace.createFileSystemWatcher(this.testsGlobFilter);
        this.watcher.onDidCreate(uri => addFeature(uri));
        this.watcher.onDidChange(uri => reloadFeature(uri));
        this.watcher.onDidDelete(uri => removeFeature(uri));
        vscode.workspace.onDidChangeTextDocument(e => e.document.languageId === 'karate' && reloadFeature(e.document.uri));
    }

    public getPeekDefinitions(document: vscode.TextDocument, token: string): vscode.Definition {
        let [file, tag] = token.split('@');
        const definitions = [];
        if (file && file.startsWith('classpath:')) {
            file = file.replace('classpath:', '');
            if (file.endsWith('.feature') || file.endsWith('.yml') || file.endsWith('.json') || file.endsWith('.js')) {
                definitions.push(...this.findInClassPathFolders(file));
            } else {
                definitions.push(
                    ...this.cachedClasspathFiles
                        .filter(f => minimatch(f, file + '*', { matchBase: true }))
                        .flatMap(f => this.findInClassPathFolders(f))
                );
            }
        } else if (file) {
            const f = path.join(path.dirname(document.uri.fsPath), file);
            if (fs.existsSync(f) && fs.statSync(f).isFile()) {
                definitions.push(f);
            } else {
                definitions.push(...this.cachedKarateTestFiles.filter(f => minimatch(f, file + '*', { matchBase: true })));
            }
        } else {
            definitions[0] = document.uri.fsPath;
        }

        if (definitions.length === 1 && tag) {
            // console.log('searching for @tag', tag);
            const lines = fs.readFileSync(definitions[0]).toString().split('\n');
            for (let line = 0; line < lines.length; line++) {
                const lineText = lines[line].trim();
                if (lineText.startsWith('@') && lineText.split(/\s+/).includes('@' + tag)) {
                    return new vscode.Location(vscode.Uri.file(definitions[0]), new vscode.Position(line, 0));
                }
            }
        }
        // console.log('peeking', definitions);
        return definitions.map(f => new vscode.Location(vscode.Uri.file(f), new vscode.Position(0, 0)));
    }

    private findInClassPathFolders(file: string) {
        const searchPaths = this.classpathFolders
            .map(folder => path.join(folder, file))
            .flatMap(f => this.workspaceFsPaths.map(w => path.join(w, f)));
        return searchPaths.filter(f => fs.existsSync(f));
    }

    public getClasspathRelativePath(file: vscode.Uri) {
        let relativePath = vscode.workspace.asRelativePath(file.fsPath);
        for (const folder of this.classpathFolders) {
            if (relativePath.startsWith(folder)) {
                relativePath = relativePath.replace(folder, '');
                relativePath = relativePath.replace(/^\//g, '');
                break;
            }
        }

        return relativePath.replace(/\\/g, '/');
    }

    public getAutoCompleteEntries(documentUri: vscode.Uri, completionToken: string): vscode.CompletionItem[] {
        const completionStrings = [];
        completionStrings.push(...this.cachedKarateTestFiles.filter(f => f));
        completionStrings.push(...this.cachedClasspathFiles.map(f => `classpath:${f}`));
        const completionItems = completionStrings.map(f => new vscode.CompletionItem(f, vscode.CompletionItemKind.File));
        return completionItems.filter(item => item.label.toString().startsWith(completionToken));
    }

    public getKarateFiles(focus?: string): KarateTestTreeEntry[] {
        const filteredEntries = (this.cachedKarateTestFiles || []).filter(
            f => !focus || (focus.length > 0 && minimatch(f, focus, { matchBase: true }))
        );
        return this.buildEntriesTree(filteredEntries);
    }

    public getKarateFileList(): Thenable<vscode.Uri[]> {
        return vscode.workspace.findFiles(this.testsGlobFilter);
    }

    public buildEntriesTree(entries: string[]) {
        const tree = {};
        for (const entry of entries) {
            const folders = entry.split('/');
            const filename = folders.pop();
            let leaf = tree;
            for (const folder of folders) {
                leaf[folder] = leaf[folder] || {};
                leaf = leaf[folder];
            }

            leaf[filename] = entry;
        }

        return this.convertToEntryTree(tree);
    }

    private convertToEntryTree(foldersEntry, parentFolder = ''): KarateTestTreeEntry[] {
        if (typeof foldersEntry === 'object') {
            return Object.entries(foldersEntry)
                .map(([key, value]) => {
                    const isDirectory = typeof value === 'object';
                    const fullPath = path.join(parentFolder, key);
                    const workspaceFolder = this.getWorkspaceFolder(fullPath);
                    const fileWithoutWorkspaceFolder = fullPath.split(/\/|\\/).slice(1).join('/');
                    const uri = vscode.Uri.joinPath(workspaceFolder.uri, fileWithoutWorkspaceFolder);
                    return new KarateTestTreeEntry({
                        uri,
                        type: isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
                        title: key,
                        // feature: { path: uri.fsPath, line: null },
                        children: isDirectory ? this.convertToEntryTree(value, fullPath) : null,
                    });
                })
                .sort((a, b) => b.type.toString().localeCompare(a.type.toString()) * 10 + a.title.localeCompare(b.title));
        }
        return foldersEntry;
    }

    private relativeToWorkspace(uri: string): string {
        return vscode.workspace.asRelativePath(uri, true);
    }

    private getWorkspaceFolder(file: string) {
        if (this.workspaceFolders?.length === 1) {
            return this.workspaceFolders[0];
        } else {
            file = file.replace(/\\/g, '/');
            return (this.workspaceFolders || []).find(f => file.startsWith(path.basename(f.uri.fsPath) + '/'));
        }
    }
}

export const filesManager = new FilesManager();
