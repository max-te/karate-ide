import { Feature, parseFeature } from '@/feature';
import { filesManager, KarateTestTreeEntry } from '@/fs/FilesManager';
import { getFileAndRootPath } from '@/feature';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCommandLine, getStartMockCommandLine } from './CommandUtils';
import { Event, KarateExecutionProcess } from './KarateExecutionProcess';

let lastExecution = null;
let lastExecutionType: 'RUN' | 'DEBUG' = null;

export function getDebugFile() {
    return lastExecution;
}

export function launchTest(feature, line, type: 'RUN' | 'DEBUG') {
    lastExecution = feature + (line > 1 ? `:${line}` : '');
    lastExecutionType = type;
    runHandler(type === 'DEBUG', { include: [testItems.get(lastExecution)], exclude: null, profile: null }, null);
}

export function relaunchTest(type: 'RUN' | 'DEBUG' = lastExecutionType) {
    launchTest(lastExecution, 0, type);
}

export function debugKarateTest(feature, line) {
    lastExecutionType = 'DEBUG';
    lastExecution = feature + (line > 1 ? `:${line}` : '');
    vscode.commands.executeCommand('workbench.action.debug.start');
}

export async function runKarateTest(feature, line) {
    lastExecutionType = 'RUN';
    lastExecution = feature + (line > 1 ? `:${line}` : '');
    const fileAndRootPath = getFileAndRootPath(vscode.Uri.file(lastExecution));
    const runCommand = await getCommandLine('RUN', fileAndRootPath.file);

    KarateExecutionProcess.executeInTestServer(fileAndRootPath.root, runCommand);
}

let testsController = vscode.tests.createTestController('karate', 'Karate Tests');
const mocksController = vscode.tests.createTestController('mocks', 'Karate Mocks');
const testItems = new Map<string, vscode.TestItem>();
const testPaths = new Map<string, string>();

export function reloadKarateTestsController() {
    testItems.clear();
    testPaths.clear();
    testsController.items.replace([]);
    // testsController.dispose();
    // testsController = vscode.tests.createTestController('karate', 'Karate Tests');
    mocksController.items.replace([]);
    const karateFiles = filesManager.getKarateFiles();
    function addTestItems(karateTestEntries: KarateTestTreeEntry[], parent: vscode.TestItemCollection) {
        karateTestEntries.forEach(async element => {
            if (element.type === vscode.FileType.Directory) {
                const folder = testsController.createTestItem(element.uri.fsPath, element.title, element.uri);
                parent.add(folder);
                testItems.set(folder.id, folder);
                testPaths.set(folder.id, element.uri.fsPath);
                addTestItems(element.children, folder.children);
            } else if (element.type === vscode.FileType.File && element.uri.fsPath.endsWith('.feature')) {
                await processFeature(element, parent);
            }
        });
    }
    addTestItems(karateFiles, testsController.items);
    console.log('Karate tests reloaded', karateFiles.length);
}

let addFeatureTimeout: NodeJS.Timeout = null;
export async function addFeature(uri: vscode.Uri) {
    if (addFeatureTimeout) {
        clearTimeout(addFeatureTimeout);
    }
    addFeatureTimeout = setTimeout(() => {
        filesManager.loadFiles();
    }, 1000);

    // const paths = uri.fsPath.split(path.sep);
    // let parent = null;
    // while (!parent && paths.length > 0) {
    //     const fsPath = paths.join(path.sep);
    //     parent = testItems.get(fsPath);
    //     paths.pop();
    // }
    // parent = (parent && parent.items) || testsController.items;
    // processFeature(new KarateTestTreeEntry({ uri, type: vscode.FileType.File, title: path.basename(uri.fsPath) }), parent);
}

export async function removeFeature(uri: vscode.Uri) {
    const parent = testItems.get(path.dirname(uri.fsPath)).children;
    parent && parent.delete(uri.fsPath);
}

export async function reloadFeature(uri: vscode.Uri) {
    await processFeature(new KarateTestTreeEntry({ uri, type: vscode.FileType.File, title: path.basename(uri.fsPath) }));
}

async function processFeature(element: KarateTestTreeEntry, parent?: vscode.TestItemCollection) {
    const feature: Feature = await parseFeature(element.uri);
    if (!feature) {
        return;
    }
    if (feature.tags.includes('@mock')) {
        const mockItem = mocksController.createTestItem(element.uri.fsPath, element.title, element.uri);
        mockItem.tags = feature.tags.map(tag => new vscode.TestTag(tag));
        mockItem.range = new vscode.Range(0, 0, 1, 0);
        mockItem.canResolveChildren = false;
        mocksController.items.add(mockItem);
        return;
    }

    if (!parent) {
        parent = testItems.get(path.dirname(element.uri.fsPath)).children;
    }

    const featureTestItem = testsController.createTestItem(element.uri.fsPath, element.title, element.uri);
    parent.delete(featureTestItem.id);
    featureTestItem.tags = feature.tags.map(tag => new vscode.TestTag(tag));
    featureTestItem.range = new vscode.Range(0, 0, 1, 0);

    feature.scenarios.forEach(scenario => {
        if (scenario.tags.includes('@ignore')) {
            return; // continue next loop
        }
        const scenarioTestItem = testsController.createTestItem(
            `${featureTestItem.uri.fsPath}:${scenario.line}`,
            scenario.title,
            featureTestItem.uri
        );
        scenarioTestItem.range = new vscode.Range(scenario.line - 1, 0, scenario.line, 0);
        scenarioTestItem.tags = scenario.tags.map(tag => new vscode.TestTag(tag));
        scenario.examples.forEach(example => {
            const id = [featureTestItem.uri.fsPath, example.line, example.title].join(':');
            const exampleTestItem = testsController.createTestItem(id, example.title, featureTestItem.uri);
            exampleTestItem.range = new vscode.Range(example.line - 1, 0, example.line, 0);
            exampleTestItem.tags = example.tags.map(tag => new vscode.TestTag(tag));

            scenarioTestItem.children.add(exampleTestItem);
            testItems.set(exampleTestItem.id, exampleTestItem);
            testPaths.set(exampleTestItem.id, `${featureTestItem.uri.fsPath}:${example.line}`);
        });

        testItems.set(scenarioTestItem.id, scenarioTestItem);
        testPaths.set(scenarioTestItem.id, `${featureTestItem.uri.fsPath}:${scenario.line}`);
        featureTestItem.children.add(scenarioTestItem);
    });

    if (feature.tags.includes('@ignore')) {
        return;
    }
    if (featureTestItem.children.size > 0) {
        // TODO filter @ignore and @mock
        parent.add(featureTestItem);
        testItems.set(featureTestItem.id, featureTestItem);
        testPaths.set(featureTestItem.id, element.uri.fsPath);
    }
}

let testRunner: vscode.TestRun | undefined;
function runHandler(shouldDebug: boolean, request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    testRunner = testsController.createTestRun(request);
    const command = shouldDebug ? debugKarateTest : runKarateTest;
    const testFeature = request.include.map(t => testPaths.get(t.id)).join(';');
    const enqueue = testItem => {
        testRunner.enqueued(testItem);
        testItem.children.forEach(testItem => enqueue(testItem));
    };
    request.include.forEach(testItem => enqueue(testItem));
    command(testFeature, null);

    token?.onCancellationRequested(() => {
        KarateExecutionProcess.stopTestProcesses();
    });
}

let mockRunner: vscode.TestRun | undefined;
async function mockHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    mockRunner = mocksController.createTestRun(request);
    const mocks = request.include.map(t => vscode.Uri.file(t.id));

    const openapi = request.include[0].tags.find(tag => tag.id.startsWith('@openapi-file='))?.id.replace('@openapi-file=', '');
    const openapiFiles = (await vscode.workspace.findFiles(openapi)).map(f => f.fsPath.replace(/\\/g, '/'));
    const mockPaths = mocks.map(f => f.fsPath.replace(/\\/g, '/')).join(',');

    const command = await getStartMockCommandLine(openapiFiles[0], mockPaths);
    let exec = new vscode.ShellExecution(command, {});
    let task = new vscode.Task({ type: 'karate' }, vscode.TaskScope.Workspace, 'Karate Mock Server', 'karate', exec, []);

    const runningMocks = mocks;
    vscode.tasks.executeTask(task);
    runningMocks.forEach(mock => {
        mockRunner.started(mocksController.items.get(mock.fsPath));
    });

    vscode.tasks.onDidEndTask(e => {
        if (e.execution.task.name === 'Karate Mock Server') {
            if (mockRunner && runningMocks) {
                runningMocks.forEach(mock => {
                    mockRunner.passed(mocksController.items.get(mock.fsPath));
                });
            }
        }
    });

    token.onCancellationRequested(() => {
        vscode.tasks.taskExecutions.find(t => t.task.name === 'Karate Mock Server').terminate();
    });
}

let featureErrors = [];
let outlineErrors = [];
export function processEvent(event: Event): void {
    if (event.event === 'testSuiteStarted') {
    } else if (event.event === 'featureStarted') {
        featureErrors = [];
        // testRunner.started(findTestItem(event.cwd, event.locationHint));
    } else if (event.event === 'featureFinished') {
    } else if (event.event === 'testOutlineStarted') {
        outlineErrors = [];
        testRunner.started(findTestItem(event.cwd, event.locationHint));
    } else if (event.event === 'testStarted') {
        const item = findTestItem(event.cwd, event.locationHint);
        testRunner.started(item);
    } else if (event.event === 'testFinished') {
        const item = findTestItem(event.cwd, event.locationHint);
        console.log('testFinished', item, event);
        testRunner.passed(item, event.duration);
    } else if (event.event === 'testFailed') {
        const errorMessage = new vscode.TestMessage(`${event.message}: ${event.details}`);
        featureErrors.push(errorMessage);
        outlineErrors.push(errorMessage);
        testRunner.failed(findTestItem(event.cwd, event.locationHint), errorMessage);
    } else if (event.event === 'testOutlineFinished') {
        if (outlineErrors.length > 0) {
            testRunner.failed(findTestItem(event.cwd, event.locationHint), outlineErrors);
        } else {
            testRunner.passed(findTestItem(event.cwd, event.locationHint), event.duration);
        }
    } else if (event.event === 'testSuiteFinished') {
        testRunner.end();
    }
}

function findTestItem(cwd: string, locationHint: string): vscode.TestItem | undefined {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(cwd), locationHint.replace(/:1$/, ''));
    const testItem = testItems.get(uri.fsPath);
    return testItem;
}

const runProfile = testsController.createRunProfile('Run Karate', vscode.TestRunProfileKind.Run, (request, token) => {
    runHandler(false, request, token);
});

const debugProfile = testsController.createRunProfile('Debug Karate', vscode.TestRunProfileKind.Debug, (request, token) => {
    runHandler(true, request, token);
});

const mockProfile = mocksController.createRunProfile('Start Mock', vscode.TestRunProfileKind.Run, async (request, token) => {
    await mockHandler(request, token);
});

const mockStopProfile = mocksController.createRunProfile('Stop Mock', vscode.TestRunProfileKind.Run, async (request, token) => {
    vscode.tasks.taskExecutions.find(t => t.task.name === 'Karate Mock Server').terminate();
});

export const disposables = [runProfile, debugProfile, mockProfile, mockStopProfile, testsController, mocksController];
