import assert from 'assert';
import fs from 'fs';
import superagent from 'superagent';
import type { SuperAgentRequest } from 'superagent';
import { filter } from 'lodash';
import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import path from 'path';
import os from 'os';
import { TaskQueue } from './task-queue';

const DEFAULT_BASE_URL = process.env.LOJ_BASE_URL || 'https://loj.ac';
const DEFAULT_OUTPUT_ROOT = path.join(__dirname, 'downloads');
const RE_SYZOJ = /(https?):\/\/([^/]+)\/(problem|p)\/([0-9]+)\/?/i;
const ScoreTypeMap: Record<string, string> = {
    GroupMin: 'min',
    Sum: 'sum',
    GroupMul: 'max',
};
const LanguageMap: Record<string, string> = {
    cpp: 'cc',
};
const fileQueue = new TaskQueue({
    concurrency: parsePositiveInteger(process.env.DOWNLOAD_CONCURRENCY, 5),
});

export interface ProblemProgress {
    stage: 'metadata' | 'download' | 'archive' | 'completed' | 'range';
    progress: number;
    message: string;
    downloadedCount?: number;
    totalCount?: number;
    downloadedSize?: number;
    totalSize?: number;
    currentFile?: string;
    currentProblemId?: number;
    processedProblemCount?: number;
    totalProblemCount?: number;
    failedProblemIds?: number[];
}

export interface RequestOptions {
    cookie?: string;
    retry?: number;
    userAgent?: string;
    timeout?: {
        response: number;
        deadline: number;
    };
}

export interface DownloadTreeOptions {
    baseUrl?: string;
    outputRoot?: string;
    request?: RequestOptions;
    onProblemProgress?: (progress: ProblemProgress) => void;
}

export interface DownloadArchiveOptions extends DownloadTreeOptions {
    archiveDir?: string;
}

export interface RunOptions extends DownloadTreeOptions {
    onTotalProgress?: (progress: number, message: string) => void;
}

export interface DownloadTreeResult {
    baseUrl: string;
    host: string;
    problemId: number;
    packageDir: string;
    sourceUrl: string;
}

export interface DownloadArchiveResult extends DownloadTreeResult {
    archiveName: string;
    archivePath: string;
}

export interface DownloadRangeArchiveResult {
    baseUrl: string;
    host: string;
    startId: number;
    endId: number;
    packageDir: string;
    archiveName: string;
    archivePath: string;
    failedProblemIds: number[];
    successfulProblemCount: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
    return baseUrl.replace(/\/+$/, '');
}

function sanitizeHost(host: string) {
    return host.replace(/[^a-z0-9.-]+/gi, '_');
}

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function toErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'Unknown error';
}

function removeIfExists(target: string) {
    if (!fs.existsSync(target)) return;
    const fileSystem = fs as typeof fs & {
        removeSync?: (path: string) => void;
        rmSync?: (path: string, options?: { force?: boolean; recursive?: boolean }) => void;
    };
    if (typeof fileSystem.rmSync === 'function') {
        fileSystem.rmSync(target, { recursive: true, force: true });
        return;
    }
    if (typeof fileSystem.removeSync === 'function') {
        fileSystem.removeSync(target);
        return;
    }
    throw new Error(`Cannot remove existing path: ${target}`);
}

function prepareRequest(request: SuperAgentRequest, options: RequestOptions = {}, retry = options.retry ?? 3) {
    request.retry(retry).timeout(options.timeout || { response: 3000, deadline: 60000 });
    if (options.cookie) request.set('Cookie', options.cookie);
    request.set('User-Agent', options.userAgent || 'Mozilla/5.0 loj-download-web');
    return request;
}

function createGetRequest(url: string, options: RequestOptions = {}, retry?: number) {
    return prepareRequest(superagent.get(url), options, retry);
}

function createPostRequest(url: string, options: RequestOptions = {}, retry?: number) {
    return prepareRequest(superagent.post(url), options, retry);
}

async function downloadToPath(url: string, targetPath: string, options: RequestOptions = {}, retry?: number) {
    const attempts = retry ?? options.retry ?? 5;
    const requestOptions: RequestOptions = {
        ...options,
        timeout: options.timeout || { response: 10000, deadline: 180000 },
    };
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const request = createGetRequest(url, requestOptions, 0);
        const writer = fs.createWriteStream(targetPath);

        try {
            request.pipe(writer);
            await new Promise<void>((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                request.on('error', reject);
                request.on('timeout', reject);
            });
            return targetPath;
        } catch (error) {
            lastError = error;
            writer.destroy();
            request.abort();
            if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
            if (attempt === attempts) break;
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
    }

    throw lastError;
}

function createWriter(baseDir: string) {
    return (filename: string, content?: Buffer | string) => {
        const targetPath = path.join(baseDir, filename);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        if (content === undefined) return targetPath;
        fs.writeFileSync(targetPath, content);
        return targetPath;
    };
}

function createProblemDirectory(outputRoot: string, host: string, problemId: number) {
    const packageDir = path.join(path.resolve(outputRoot), host, String(problemId));
    removeIfExists(packageDir);
    fs.mkdirSync(packageDir, { recursive: true });
    return packageDir;
}

function emitProblemProgress(options: DownloadTreeOptions, progress: ProblemProgress) {
    options.onProblemProgress?.({
        ...progress,
        progress: Math.max(0, Math.min(1, progress.progress)),
    });
}

function buildDownloadMessage(
    name: string,
    downloadedCount: number,
    totalCount: number,
    downloadedSize: number,
    totalSize: number,
) {
    const countText = totalCount > 0 ? ` (${downloadedCount}/${totalCount})` : '';
    if (totalSize > 0) {
        return `${name}${countText} ${formatBytes(downloadedSize)}/${formatBytes(totalSize)}`;
    }
    return `${name}${countText}`;
}

async function downloadLegacyProblem(url: string, outputDir: string, options: DownloadTreeOptions) {
    emitProblemProgress(options, {
        stage: 'metadata',
        progress: 0.05,
        message: 'Fetching legacy problem metadata',
    });
    const res = await createGetRequest(`${url}export`, options.request).ok(() => true);
    assert(res.status === 200, new Error('Cannot connect to target server.'));
    assert(res.body.success, new Error((res.body.error || {}).message || 'Export API returned an error.'));
    const problem = res.body.obj;
    const problemUrl = new URL(url);
    const pid = Number.parseInt(problemUrl.pathname.split('problem/')[1].split('/')[0], 10);
    const write = createWriter(outputDir);
    let content = '';
    if (problem.description) content += `## 题目描述\n${problem.description}\n\n`;
    if (problem.input_format) content += `## 输入格式\n${problem.input_format}\n\n`;
    if (problem.output_format) content += `## 输出格式\n${problem.output_format}\n\n`;
    if (problem.example) content += `## 样例\n${problem.example}\n\n`;
    if (problem.hint) content += `## 提示\n${problem.hint}\n\n`;
    if (problem.limit_and_hint) content += `## 限制与提示\n${problem.limit_and_hint}\n\n`;
    write('problem_zh.md', content);
    write('problem.yaml', yaml.dump({
        title: problem.title,
        owner: 1,
        tag: problem.tags || [],
        pid: `P${pid}`,
        nSubmit: 0,
        nAccept: 0,
    }));

    const tmpDir = path.resolve(os.tmpdir(), 'hydro');
    fs.mkdirSync(tmpDir, { recursive: true });
    const testdataArchive = path.join(tmpDir, `import_${pid}_${Date.now()}.zip`);

    emitProblemProgress(options, {
        stage: 'download',
        progress: 0.2,
        message: 'Downloading test data archive',
    });
    try {
        await downloadToPath(`${url}testdata/download`, testdataArchive, options.request);
        const zip = new AdmZip(testdataArchive);
        for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            write(`testdata/${entry.entryName.split('/').pop()}`, entry.getData());
        }
        const filename = problem.file_io_input_name ? problem.file_io_input_name.split('.')[0] : null;
        write('testdata/config.yaml', yaml.dump({
            time: `${problem.time_limit || 1000}ms`,
            memory: `${problem.memory_limit || 256}m`,
            filename,
            type: problem.type === 'traditional' ? 'default' : problem.type,
        }));
    } finally {
        if (fs.existsSync(testdataArchive)) fs.unlinkSync(testdataArchive);
    }

    if (problem.have_additional_file) {
        const additionalArchive = path.join(tmpDir, `import_${pid}_a_${Date.now()}.zip`);
        emitProblemProgress(options, {
            stage: 'download',
            progress: 0.75,
            message: 'Downloading additional files archive',
        });
        try {
            await downloadToPath(`${url}download/additional_file`, additionalArchive, options.request);
            const zip = new AdmZip(additionalArchive);
            for (const entry of zip.getEntries()) {
                if (entry.isDirectory) continue;
                write(`additional_file/${entry.entryName.replace(/\//g, '_')}`, entry.getData());
            }
        } finally {
            if (fs.existsSync(additionalArchive)) fs.unlinkSync(additionalArchive);
        }
    }

    emitProblemProgress(options, {
        stage: 'completed',
        progress: 1,
        message: 'Problem package is ready',
    });
}

async function downloadV3Problem(
    protocol: string,
    host: string,
    pid: number,
    outputDir: string,
    options: DownloadTreeOptions,
) {
    emitProblemProgress(options, {
        stage: 'metadata',
        progress: 0.05,
        message: 'Fetching problem metadata',
    });
    const apiHost = host === 'loj.ac' ? 'api.loj.ac' : host;
    const result = await createPostRequest(`${protocol}://${apiHost}/api/problem/getProblem`, options.request)
        .send({
            additionalFiles: true,
            displayId: pid,
            judgeInfo: true,
            localizedContentsOfAllLocales: true,
            samples: true,
            tagsOfLocale: 'zh_CN',
            testData: true,
        });

    if (result.body.error === 'PERMISSION_DENIED') {
        throw new Error('Permission denied. This problem may require login. Configure LOJ_COOKIE on the server and try again.');
    }
    if (!result.body.localizedContentsOfAllLocales?.length) {
        throw new Error('Problem not found or is not publicly accessible.');
    }

    const write = createWriter(outputDir);
    for (const localizedContent of result.body.localizedContentsOfAllLocales) {
        let content = '';
        let add = false;
        for (const section of localizedContent.contentSections) {
            if (section.type === 'Sample') {
                if (section.sampleId === 0) add = true;
                content += `\`\`\`input${add ? section.sampleId + 1 : section.sampleId}\n`;
                content += `${result.body.samples[section.sampleId].inputData}\n`;
                content += `\`\`\`\n\n`;
                content += `\`\`\`output${add ? section.sampleId + 1 : section.sampleId}\n`;
                content += `${result.body.samples[section.sampleId].outputData}\n`;
                content += `\`\`\`\n\n`;
                if (section.text) content += `${section.text}\n\n`;
                continue;
            }
            content += `## ${section.sectionTitle}\n\n${section.text}\n\n`;
        }
        let locale = localizedContent.locale;
        if (locale === 'en_US') locale = 'en';
        else if (locale === 'zh_CN') locale = 'zh';
        write(`problem_${locale}.md`, content);
    }

    const tags = (result.body.tagsOfLocale || []).map((node) => node.name);
    const title = [
        ...filter(result.body.localizedContentsOfAllLocales, (node) => node.locale === 'zh_CN'),
        ...result.body.localizedContentsOfAllLocales,
    ][0].title;
    write('problem.yaml', yaml.dump({
        title,
        owner: 1,
        tag: tags,
        pid: `P${pid}`,
        nSubmit: result.body.meta.submissionCount,
        nAccept: result.body.meta.acceptedSubmissionCount,
    }));

    const judge = result.body.judgeInfo;
    const rename: Record<string, string> = {};
    if (judge) {
        const config: Record<string, unknown> = {
            memory: `${judge.memoryLimit}m`,
            time: `${judge.timeLimit}ms`,
        };
        if (judge.extraSourceFiles) {
            const files: string[] = [];
            for (const key in judge.extraSourceFiles) {
                for (const file in judge.extraSourceFiles[key]) files.push(file);
            }
            config.user_extra_files = files;
        }
        if (judge.checker?.type === 'custom') {
            config.checker_type = judge.checker.interface === 'legacy' ? 'syzoj' : judge.checker.interface;
            if (LanguageMap[judge.checker.language]) {
                rename[judge.checker.filename] = `chk.${LanguageMap[judge.checker.language]}`;
                config.checker = `chk.${LanguageMap[judge.checker.language]}`;
            } else {
                config.checker = judge.checker.filename;
            }
        }
        if (judge.fileIo?.inputFilename) {
            config.filename = judge.fileIo.inputFilename.split('.')[0];
        }
        if (judge.subtasks?.length) {
            config.subtasks = judge.subtasks.map((subtask) => {
                const current: Record<string, unknown> = {
                    cases: subtask.testcases.map((item) => ({
                        input: item.inputFile,
                        output: item.outputFile,
                    })),
                    score: subtask.points,
                    type: ScoreTypeMap[subtask.scoringType],
                };
                if (subtask.dependencies) current.if = subtask.dependencies;
                return current;
            });
        }
        write('testdata/config.yaml', Buffer.from(yaml.dump(config)));
    }

    const testData = result.body.testData || [];
    const additionalFiles = result.body.additionalFiles || [];
    const totalCount = testData.length + additionalFiles.length;
    const totalSize = testData.reduce((sum, item) => sum + item.size, 0)
        + additionalFiles.reduce((sum, item) => sum + item.size, 0);
    let downloadedCount = 0;
    let downloadedSize = 0;

    const testDataResponse = testData.length
        ? await createPostRequest(
            `${protocol}://${apiHost}/api/problem/downloadProblemFiles`,
            {
                ...options.request,
                timeout: { response: 10000, deadline: 60000 },
            },
            5,
        ).send({
            filenameList: testData.map((node) => node.filename),
            problemId: result.body.meta.id,
            type: 'TestData',
        })
        : { body: { downloadInfo: [] } };
    const additionalFilesResponse = additionalFiles.length
        ? await createPostRequest(
            `${protocol}://${apiHost}/api/problem/downloadProblemFiles`,
            {
                ...options.request,
                timeout: { response: 10000, deadline: 60000 },
            },
            5,
        ).send({
            filenameList: additionalFiles.map((node) => node.filename),
            problemId: result.body.meta.id,
            type: 'AdditionalFile',
        })
        : { body: { downloadInfo: [] } };

    if (testDataResponse.body.error) {
        throw new Error(testDataResponse.body.error.message || testDataResponse.body.error);
    }
    if (additionalFilesResponse.body.error) {
        throw new Error(additionalFilesResponse.body.error.message || additionalFilesResponse.body.error);
    }

    const tasks: Array<{
        expectedSize: number;
        filepath: string;
        name: string;
        url: string;
    }> = [];
    for (const file of testDataResponse.body.downloadInfo) {
        const item = testData.find((node) => node.filename === file.filename);
        tasks.push({
            expectedSize: item?.size || 0,
            filepath: `testdata/${rename[file.filename] || file.filename}`,
            name: rename[file.filename] || file.filename,
            url: file.downloadUrl,
        });
    }
    for (const file of additionalFilesResponse.body.downloadInfo) {
        const item = additionalFiles.find((node) => node.filename === file.filename);
        tasks.push({
            expectedSize: item?.size || 0,
            filepath: `additional_file/${rename[file.filename] || file.filename}`,
            name: rename[file.filename] || file.filename,
            url: file.downloadUrl,
        });
    }

    if (!tasks.length) {
        emitProblemProgress(options, {
            stage: 'completed',
            progress: 1,
            message: 'Problem package is ready',
        });
        return;
    }

    emitProblemProgress(options, {
        stage: 'download',
        progress: 0.1,
        message: 'Downloading problem files',
        downloadedCount,
        downloadedSize,
        totalCount,
        totalSize,
    });

    const taskResults = await Promise.allSettled(tasks.map((task) => fileQueue.add(async () => {
        const targetPath = write(task.filepath);
        if (fs.existsSync(targetPath)) {
            const existingSize = fs.statSync(targetPath).size;
            if (existingSize === task.expectedSize) {
                downloadedCount += 1;
                downloadedSize += task.expectedSize;
                emitProblemProgress(options, {
                    currentFile: task.name,
                    downloadedCount,
                    downloadedSize,
                    message: buildDownloadMessage(task.name, downloadedCount, totalCount, downloadedSize, totalSize),
                    progress: totalSize > 0 ? downloadedSize / totalSize : downloadedCount / totalCount,
                    stage: 'download',
                    totalCount,
                    totalSize,
                });
                return;
            }
        }

        await downloadToPath(task.url, targetPath, options.request);
        downloadedCount += 1;
        downloadedSize += task.expectedSize;
        emitProblemProgress(options, {
            currentFile: task.name,
            downloadedCount,
            downloadedSize,
            message: buildDownloadMessage(task.name, downloadedCount, totalCount, downloadedSize, totalSize),
            progress: totalSize > 0 ? downloadedSize / totalSize : downloadedCount / totalCount,
            stage: 'download',
            totalCount,
            totalSize,
        });
    })));

    const failedTask = taskResults.find((resultItem) => resultItem.status === 'rejected');
    if (failedTask && failedTask.status === 'rejected') throw failedTask.reason;

    emitProblemProgress(options, {
        stage: 'completed',
        progress: 1,
        message: 'Problem package is ready',
        downloadedCount,
        downloadedSize,
        totalCount,
        totalSize,
    });
}

export async function downloadProblemTreeById(problemId: number, options: DownloadTreeOptions = {}) {
    assert(Number.isSafeInteger(problemId) && problemId > 0, new Error('Problem id must be a positive integer.'));
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const base = new URL(baseUrl);
    const packageDir = createProblemDirectory(options.outputRoot || DEFAULT_OUTPUT_ROOT, base.host, problemId);
    await downloadV3Problem(base.protocol.slice(0, -1), base.host, problemId, packageDir, options);
    return {
        baseUrl,
        host: base.host,
        packageDir,
        problemId,
        sourceUrl: `${baseUrl}/p/${problemId}`,
    } satisfies DownloadTreeResult;
}

export async function downloadProblemTreeByUrl(url: string, options: DownloadTreeOptions = {}) {
    assert(url.match(RE_SYZOJ), new Error('This is not a valid SYZOJ/Lyrio problem detail page link.'));
    let normalizedUrl = url;
    if (!normalizedUrl.endsWith('/')) normalizedUrl += '/';
    const [, protocol, host, type, pidText] = RE_SYZOJ.exec(normalizedUrl)!;
    const problemId = Number.parseInt(pidText, 10);
    const packageDir = createProblemDirectory(options.outputRoot || DEFAULT_OUTPUT_ROOT, host, problemId);

    if (type === 'p') {
        await downloadV3Problem(protocol, host, problemId, packageDir, options);
    } else {
        await downloadLegacyProblem(normalizedUrl, packageDir, options);
    }

    return {
        baseUrl: `${protocol}://${host}`,
        host,
        packageDir,
        problemId,
        sourceUrl: normalizedUrl,
    } satisfies DownloadTreeResult;
}

export function createProblemArchive(sourceDir: string, archivePath: string, rootName: string) {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    const zip = new AdmZip();
    zip.addLocalFolder(sourceDir, rootName);
    zip.writeZip(archivePath);
    return archivePath;
}

export async function downloadProblemArchiveById(problemId: number, options: DownloadArchiveOptions = {}) {
    const tree = await downloadProblemTreeById(problemId, options);
    const archiveDir = path.resolve(options.archiveDir || options.outputRoot || DEFAULT_OUTPUT_ROOT);
    const archiveName = `${sanitizeHost(tree.host)}-P${tree.problemId}.zip`;
    const archivePath = path.join(archiveDir, archiveName);
    emitProblemProgress(options, {
        stage: 'archive',
        progress: 0.95,
        message: 'Creating archive',
    });
    createProblemArchive(tree.packageDir, archivePath, `${sanitizeHost(tree.host)}-P${tree.problemId}`);
    emitProblemProgress(options, {
        stage: 'completed',
        progress: 1,
        message: 'Download archive is ready',
    });
    return {
        ...tree,
        archiveName,
        archivePath,
    } satisfies DownloadArchiveResult;
}

export async function downloadProblemArchiveByRange(
    startId: number,
    endId: number,
    options: DownloadArchiveOptions = {},
) {
    assert(Number.isSafeInteger(startId) && startId > 0, new Error('Range start must be a positive integer.'));
    assert(Number.isSafeInteger(endId) && endId > 0, new Error('Range end must be a positive integer.'));
    assert(startId <= endId, new Error('Range start cannot be greater than range end.'));

    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const base = new URL(baseUrl);
    const host = base.host;
    const hostRootDir = path.join(path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT), host);
    removeIfExists(hostRootDir);
    fs.mkdirSync(hostRootDir, { recursive: true });

    const totalProblemCount = endId - startId + 1;
    const failedProblemIds: number[] = [];
    let successfulProblemCount = 0;
    let processedProblemCount = 0;

    for (let problemId = startId; problemId <= endId; problemId += 1) {
        const problemDir = path.join(hostRootDir, String(problemId));
        removeIfExists(problemDir);
        fs.mkdirSync(problemDir, { recursive: true });

        emitProblemProgress(options, {
            currentProblemId: problemId,
            failedProblemIds: [...failedProblemIds],
            message: `Preparing P${problemId} (${processedProblemCount + 1}/${totalProblemCount})`,
            processedProblemCount,
            progress: processedProblemCount / totalProblemCount,
            stage: 'range',
            totalProblemCount,
        });

        try {
            await downloadV3Problem(base.protocol.slice(0, -1), host, problemId, problemDir, {
                ...options,
                onProblemProgress(progress) {
                    emitProblemProgress(options, {
                        ...progress,
                        currentProblemId: problemId,
                        failedProblemIds: [...failedProblemIds],
                        message: `P${problemId}: ${progress.message} (${processedProblemCount + 1}/${totalProblemCount})`,
                        processedProblemCount,
                        progress: (processedProblemCount + progress.progress) / totalProblemCount,
                        totalProblemCount,
                    });
                },
            });
            successfulProblemCount += 1;
        } catch (error) {
            failedProblemIds.push(problemId);
            removeIfExists(problemDir);
            emitProblemProgress(options, {
                currentProblemId: problemId,
                failedProblemIds: [...failedProblemIds],
                message: `Skipping P${problemId}: ${toErrorMessage(error)}`,
                processedProblemCount: processedProblemCount + 1,
                progress: (processedProblemCount + 1) / totalProblemCount,
                stage: 'range',
                totalProblemCount,
            });
        }

        processedProblemCount += 1;
    }

    if (!successfulProblemCount) {
        throw new Error(`No problems in range P${startId}-P${endId} were downloaded successfully.`);
    }

    const archiveDir = path.resolve(options.archiveDir || options.outputRoot || DEFAULT_OUTPUT_ROOT);
    const archiveName = `${sanitizeHost(host)}-P${startId}-P${endId}.zip`;
    const archivePath = path.join(archiveDir, archiveName);
    emitProblemProgress(options, {
        failedProblemIds: [...failedProblemIds],
        message: `Creating archive for P${startId}-P${endId}`,
        processedProblemCount: totalProblemCount,
        progress: 0.95,
        stage: 'archive',
        totalProblemCount,
    });
    createProblemArchive(hostRootDir, archivePath, `${sanitizeHost(host)}-P${startId}-P${endId}`);
    emitProblemProgress(options, {
        failedProblemIds: [...failedProblemIds],
        message: failedProblemIds.length
            ? `Archive is ready. Failed: ${failedProblemIds.map((problemId) => `P${problemId}`).join(', ')}`
            : 'Download archive is ready',
        processedProblemCount: totalProblemCount,
        progress: 1,
        stage: 'completed',
        totalProblemCount,
    });

    return {
        archiveName,
        archivePath,
        baseUrl,
        endId,
        failedProblemIds,
        host,
        packageDir: hostRootDir,
        startId,
        successfulProblemCount,
    } satisfies DownloadRangeArchiveResult;
}

export async function run(url: string, options: RunOptions = {}) {
    const rangeMatch = /^(.+)\/(\d+)\.\.(\d+)$/.exec(url);
    if (rangeMatch) {
        let prefix = rangeMatch[1];
        const start = Number.parseInt(rangeMatch[2], 10);
        const end = Number.parseInt(rangeMatch[3], 10);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
            throw new Error('Invalid problem range.');
        }
        if (!prefix.endsWith('/')) prefix += '/';
        let version = 2;
        if (prefix.endsWith('/p/')) version = 3;
        else prefix = `${prefix.split('/problem/')[0]}/problem/`;
        const base = `${prefix}${start}/`;
        assert(base.match(RE_SYZOJ), new Error('Invalid problem range prefix.'));
        const [, protocol, host] = RE_SYZOJ.exec(base)!;
        const count = end - start + 1;
        for (let current = start; current <= end; current += 1) {
            options.onTotalProgress?.((current - start) / count, `${prefix}${current}`);
            const targetUrl = version === 3
                ? `${protocol}://${host}/p/${current}/`
                : `${protocol}://${host}/problem/${current}/`;
            await downloadProblemTreeByUrl(targetUrl, options);
        }
        options.onTotalProgress?.(1, '');
        return;
    }

    await downloadProblemTreeByUrl(url, options);
}

export { normalizeBaseUrl };
