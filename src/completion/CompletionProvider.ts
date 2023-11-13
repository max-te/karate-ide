import { filesManager } from '@/fs/FilesManager';
import * as vscode from 'vscode';
import path = require('path');
import fs = require('fs');

export class CompletionItemProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        cancellation: vscode.CancellationToken,
        context: vscode.CompletionContext
    ) {
        const completionToken = document.lineAt(position).text.slice(0, position.character);

        const regex = /read\(['"](.*)$|['"](classpath:.*)$|['"](file:.*)$/gm;
        const groups = regex.exec(completionToken);
        if (!groups) {
            return undefined;
        }
        const filePrefix = groups ? groups[1] ?? groups[2] ?? groups[3] : '';
        const trimmedPrefix = filePrefix.replace(/(^|[:/])([^:./]*)$/gm, '$1');

        return filesManager.getAutoCompleteEntries(document.uri, filePrefix).map(item => {
            const importPath = item.label.toString();
            item.detail = importPath;
            item.insertText = importPath.replace(filePrefix, '');
            item.label = importPath.replace(trimmedPrefix, '');
            return item;
        });
    }
}
