import EventLogsServer from '@/server/EventLogsServer';
import * as path from 'path';
import * as vscode from 'vscode';

function getPlatformString() {
    switch (process.platform) {
        case 'win32':
            return 'windows';
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'osx';
    }

    return 'unknown';
}

function getPlatformConfiguration<T>(key: string): T {
    const platform = getPlatformString();
    const config = vscode.workspace.getConfiguration('karateIDE.karateCli');
    const platformSpecificConfig = config.get<T>(key + '.' + platform);
    const globalConfig = config.get<T>(key);

    return platformSpecificConfig || globalConfig;
}

export function getKarateOptions() {
    const karateEnv: string = getPlatformConfiguration('karateEnv');
    const karateOptions: string = getPlatformConfiguration('karateOptions');
    if (Boolean(getPlatformConfiguration('addHookToClasspath'))) {
        return '-H vscode.VSCodeHook ' + karateOptions;
    }
    return karateOptions.replace('${karateEnv}', karateEnv);
}

export async function getCommandLine(type: 'RUN' | 'DEBUG', feature?: string) {
    const commandName = type === 'RUN' ? 'runCommandTemplate' : 'debugCommandTemplate';

    const vscodePort = EventLogsServer.getPort();
    const karateEnv: string = getPlatformConfiguration('karateEnv');
    const classpath: string = getPlatformConfiguration('classpath');
    const karateOptions: string = getKarateOptions();
    let debugCommandTemplate: string = getPlatformConfiguration(commandName);

    return debugCommandTemplate
        .replace('${vscodePort}', vscodePort)
        .replace('${karateEnv}', karateEnv)
        .replace('${classpath}', processClasspath(classpath))
        .replace('${karateOptions}', karateOptions)
        .replace('${feature}', feature);
}

export function processClasspath(classpath: string, jar: 'vscode.jar' | 'zenwave-apimock.jar' | string = 'vscode.jar') {
    if (classpath.includes('${m2.repo}')) {
        const m2Repo: string =
            getPlatformConfiguration('m2Repo') ||
            (process.env.M2_REPO && process.env.M2_REPO) ||
            (process.env.HOME && path.join(process.env.HOME, '.m2/repository')) ||
            (process.env.UserProfile && path.join(process.env.UserProfile, '.m2/repository'));
        if (m2Repo) {
            classpath = classpath.replace(/\${m2\.repo}/g, m2Repo);
        }
    }
    if (classpath.includes('${ext:karate-ide.jar}')) {
        const classpathJarExtension = vscode.extensions.getExtension('KarateIDE.karate-classpath-jar');
        if (classpathJarExtension) {
            const karateJar = vscode.Uri.joinPath(vscode.Uri.file(classpathJarExtension.extensionPath), 'resources', 'karate.jar').fsPath.replace(
                /\\/g,
                '/'
            );
            classpath = classpath.replace(/\${ext\:karate-ide\.jar}/g, karateJar);
        }
    }
    if (jar === 'vscode.jar') {
        if (Boolean(getPlatformConfiguration('addHookToClasspath'))) {
            return path.join(__dirname, `../resources/${jar}`) + path.delimiter + classpath;
        }
    } else if (jar === 'zenwave-apimock.jar') {
        return path.join(__dirname, `../resources/${jar}`) + path.delimiter + classpath;
    } else {
        return jar + path.delimiter + classpath;
    }
    return classpath;
}

export async function getStartMockCommandLine(openapi: string, feature: string) {
    const classpath: string = getPlatformConfiguration('classpath');
    const mockServerOptions: string = getPlatformConfiguration('mockServerOptions');
    let debugCommandTemplate: string = getPlatformConfiguration('mockServerCommandTemplate');

    if (debugCommandTemplate.includes('${port}')) {
        debugCommandTemplate = debugCommandTemplate.replace('${port}', await vscode.window.showInputBox({ prompt: 'Mock Server Port', value: '0' }));
    }

    const apimockJarLocation: string = getPlatformConfiguration('zenWaveApiMockJarLocation');
    const apimockJar = apimockJarLocation || 'zenwave-apimock.jar';

    return debugCommandTemplate
        .replace('${classpath}', processClasspath(classpath, apimockJar))
        .replace('${mockServerOptions}', mockServerOptions)
        .replace('${openapi}', openapi || '')
        .replace('${feature}', feature || '');
}

export async function startMockServer(featureFiles: vscode.Uri[], controller: vscode.TestController, token: vscode.CancellationToken) {
    // console.log('startMockServer', arguments);
    const openapi = featureFiles.map(f => f.fsPath.replace(/\\/g, '/')).filter(f => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'));
    const features = featureFiles.map(f => f.fsPath.replace(/\\/g, '/')).filter(f => f.endsWith('.feature'));
    const command = await getStartMockCommandLine(openapi[0], features.join(','));
    let exec = new vscode.ShellExecution(command, {});
    let task = new vscode.Task({ type: 'karate' }, vscode.TaskScope.Workspace, 'Karate Mock Server', 'karate', exec, []);
    vscode.tasks.executeTask(task);
}
