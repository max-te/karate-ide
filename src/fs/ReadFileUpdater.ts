import { Disposable, FileRenameEvent, Range, WorkspaceEdit, workspace, window, ProgressLocation, Uri, TabInputText } from 'vscode';
import { filesManager } from './FilesManager';
import { TextDecoder } from 'util';

export class ReadFileUpdater {
    async handleRename(e: FileRenameEvent) {
        let yesToAll = false;
        for (const { oldUri, newUri } of e.files) {
            const oldClasspathPath = 'classpath:' + filesManager.getClasspathRelativePath(oldUri);
            const newClasspathPath = 'classpath:' + filesManager.getClasspathRelativePath(newUri);

            if (!yesToAll) {
                const answer = await window.showInformationMessage(
                    oldUri.path + ' was moved. Update all references from ' + oldClasspathPath + ' to ' + newClasspathPath + '?',
                    'Yes',
                    'Yes to all',
                    'No',
                    'No to all'
                );

                if (answer === 'No to all') {
                    break;
                }
                if (answer === 'No') {
                    continue;
                }
                if (answer === 'Yes to all') {
                    yesToAll = true;
                }
            }

            window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    cancellable: false,
                    title: 'Renaming file',
                },
                async progress => {
                    progress.report({ increment: 0 });
                    const edits = new WorkspaceEdit();
                    const fileList = await filesManager.getKarateFileList();
                    progress.report({ increment: 10 });
                    await Promise.all(
                        fileList.map(async uri => {
                            try {
                                const contents = await this.getDocumentContentsFast(uri);

                                if (contents.includes(oldClasspathPath)) {
                                    const document = await workspace.openTextDocument(uri);
                                    const indices = allIndicesOf(oldClasspathPath, document.getText());
                                    for (const index of indices) {
                                        const pos = document.positionAt(index);
                                        const endPos = pos.translate(0, oldClasspathPath.length);
                                        edits.replace(uri, new Range(pos, endPos), newClasspathPath);
                                    }
                                }
                            } catch (e) {}
                            progress.report({ increment: (1 / fileList.length) * 80 });
                        })
                    );
                    await workspace.applyEdit(edits);
                    progress.report({ increment: 10 });
                }
            );
        }
    }

    register(): Disposable {
        return workspace.onDidRenameFiles(this.handleRename.bind(this));
    }

    private async getDocumentContentsFast(uri: Uri): Promise<string> {
        for (const tabGroup of window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof TabInputText) {
                    if (tab.input.uri.fsPath === uri.fsPath) {
                        const document = await workspace.openTextDocument(uri);
                        return document.getText();
                    }
                }
            }
        }

        try {
            const decoder = new TextDecoder('utf-8');
            const contents = await workspace.fs.readFile(uri);
            return decoder.decode(contents);
        } catch {
            const document = await workspace.openTextDocument(uri);
            return document.getText();
        }
    }
}

function allIndicesOf(needle: string, haystack: string): number[] {
    const indices: number[] = [];
    let index = -1;
    while ((index = haystack.indexOf(needle, index + 1)) !== -1) {
        indices.push(index);
    }
    return indices;
}
