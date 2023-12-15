import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { filesManager } from './fs/FilesManager';

export class Feature {
    tags: string[];
    title: string;
    scenarios: Scenario[] = [];
}

export class Scenario {
    tags: string[];
    title: string;
    line: number;
    examples: Example[] = [];
}

export class Example {
    tags: string[];
    title: string;
    line: number;
}

export async function parseFeature(uri: vscode.Uri): Promise<Feature> {
    let document = null;
    try {
        document = await vscode.workspace.openTextDocument(uri);
    } catch (e) {
        console.log('ERROR in parseFeature', uri.fsPath, e.message);
        return null;
    }

    let feature: Feature = null;
    let outline: Scenario = null;
    let tags: string[] = [];
    for (let line = 0; line < document.lineCount; line++) {
        let lineText = document.lineAt(line).text.trim();
        if (lineText.startsWith('@')) {
            tags = [...tags, ...lineText.split(/\s+/).map(t => t.trim())];
        } else if (lineText.startsWith('Feature:')) {
            feature = new Feature();
            feature.tags = tags;
            feature.title = lineText.trim();
            tags = [];
        } else if (lineText.startsWith('Scenario:') || lineText.startsWith('Scenario Outline:')) {
            const scenario = new Scenario();
            scenario.line = line + 1;
            scenario.tags = tags;
            scenario.title = lineText.trim();
            feature.scenarios.push(scenario);
            tags = [];
            if (lineText.startsWith('Scenario Outline:')) {
                outline = scenario;
            }
        } else if (lineText.startsWith('Examples:')) {
            const tableLines: { text: string; lineNo: number }[] = [];
            for (line++; line < document.lineCount; line++) {
                lineText = document.lineAt(line).text.trim();
                if (lineText === '' || lineText.startsWith('#')) {
                    continue;
                } else if (lineText.startsWith('|')) {
                    tableLines.push({ text: lineText, lineNo: line + 1 });
                } else {
                    // TODO lookahead if is a new Examples
                    line = line - 1;
                    tags = [];
                    break;
                }
            }
            if (tableLines.length > 1) {
                // Classic Gherkin header-based table
                for (const row of tableLines.slice(1)) {
                    const example = new Example();
                    example.line = row.lineNo;
                    example.tags = tags;
                    example.title = row.text.replace(/\s+/g, ' ');
                    outline.examples.push(example);
                }
            } else if (tableLines.length === 1) {
                const row = tableLines[0];
                const example = new Example();
                example.line = row.lineNo;
                example.tags = tags;
                example.title = row.text.replace(/\s+/g, ' ');
                outline.examples.push(example);
            }
        }
    }

    return feature;
}

export function getFileAndRootPath(uri): { file: string; root: string } {
    let rootFolderUri = vscode.workspace.getWorkspaceFolder(uri);
    let rootModuleMarkerFile: string = vscode.workspace.getConfiguration('karateIDE.multimodule').get('rootModuleMarkerFile');

    let rootPath = rootFolderUri.uri.fsPath;
    let filePath = uri.fsPath.replace(rootPath + path.sep, '');
    let filePathArray = filePath.split(path.sep);

    if (rootModuleMarkerFile && rootModuleMarkerFile.trim().length > 0) {
        do {
            let runFileTestPath = filePathArray.join(path.sep);
            if (fs.existsSync(path.join(rootPath, runFileTestPath, rootModuleMarkerFile))) {
                rootPath = path.join(rootPath, runFileTestPath);
                filePath = uri.fsPath.replace(rootPath + path.sep, '');
                break;
            }
        } while (filePathArray.pop());
    }

    return { root: rootPath, file: filePath };
}
