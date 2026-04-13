import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import { downloadProblemArchiveById, downloadProblemArchiveByRange, normalizeBaseUrl, type ProblemProgress } from './index';
import { TaskQueue } from './task-queue';

type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
type JobKind = 'single' | 'range';

export const MAX_PROBLEM_RANGE_LENGTH = 10;

interface JobRecord {
    id: string;
    kind: JobKind;
    problemId?: number;
    rangeStart?: number;
    rangeEnd?: number;
    targetLabel: string;
    baseUrl: string;
    status: JobStatus;
    stage: string;
    progress: number;
    message: string;
    createdAt: string;
    updatedAt: string;
    downloadedCount?: number;
    totalCount?: number;
    downloadedSize?: number;
    totalSize?: number;
    archiveName?: string;
    archivePath?: string;
    currentProblemId?: number;
    processedProblemCount?: number;
    totalProblemCount?: number;
    failedProblemIds?: number[];
    warning?: string;
    error?: string;
}

export interface AppServerOptions {
    port?: number;
    host?: string;
    baseUrl?: string;
    appBasePath?: string;
    storageDir?: string;
    publicDir?: string;
    jobConcurrency?: number;
    retentionHours?: number;
    cookie?: string;
}

export interface StartedAppServer {
    server: Server;
    host: string;
    port: number;
    url: string;
    close: () => Promise<void>;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function normalizeBasePath(value: string) {
    if (!value || value === '/') return '';
    const normalized = `/${value}`.replace(/\/+/g, '/').replace(/\/$/, '');
    return normalized === '/' ? '' : normalized;
}

function toErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'Unknown error';
}

function normalizeListenUrl(host: string, port: number) {
    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `http://${displayHost}:${port}`;
}

function parseProblemInput(value: unknown) {
    const text = String(value ?? '').trim();
    const rangeMatch = /^(\d+)\s*(?:-|\.\.)\s*(\d+)$/.exec(text);
    if (rangeMatch) {
        const rangeStart = Number.parseInt(rangeMatch[1], 10);
        const rangeEnd = Number.parseInt(rangeMatch[2], 10);
        if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeStart <= 0 || rangeEnd <= 0) {
            throw new Error('Problem range must use positive integers.');
        }
        if (rangeStart > rangeEnd) {
            throw new Error('Range start cannot be greater than range end.');
        }
        if (rangeEnd - rangeStart + 1 > MAX_PROBLEM_RANGE_LENGTH) {
            throw new Error(`Problem range cannot exceed ${MAX_PROBLEM_RANGE_LENGTH} problems.`);
        }
        return {
            kind: 'range' as const,
            rangeEnd,
            rangeStart,
            targetLabel: `${rangeStart}-${rangeEnd}`,
        };
    }

    const singleMatch = /^(\d+)$/.exec(text);
    if (!singleMatch) {
        throw new Error('Please enter a positive problem id, or a range such as 1-10.');
    }

    const problemId = Number.parseInt(singleMatch[1], 10);
    if (!Number.isSafeInteger(problemId) || problemId <= 0) {
        throw new Error('Please enter a positive problem id, or a range such as 1-10.');
    }
    return {
        kind: 'single' as const,
        problemId,
        targetLabel: String(problemId),
    };
}

function resolveOptions(overrides: AppServerOptions = {}) {
    const host = overrides.host || process.env.HOST || '0.0.0.0';
    const port = overrides.port ?? parsePositiveInteger(process.env.PORT, 3000);
    const baseUrl = normalizeBaseUrl(overrides.baseUrl || process.env.LOJ_BASE_URL || 'https://loj.ac');
    const appBasePath = normalizeBasePath(overrides.appBasePath ?? process.env.APP_BASE_PATH ?? '');
    const storageDir = path.resolve(overrides.storageDir || process.env.STORAGE_DIR || path.join(__dirname, 'storage'));
    const publicDir = path.resolve(overrides.publicDir || path.join(__dirname, 'public'));
    const jobConcurrency = overrides.jobConcurrency ?? parsePositiveInteger(process.env.JOB_CONCURRENCY, 2);
    const retentionHours = overrides.retentionHours ?? parsePositiveInteger(process.env.JOB_RETENTION_HOURS, 24);
    const cookie = overrides.cookie ?? process.env.LOJ_COOKIE ?? '';

    return {
        appBasePath,
        baseUrl,
        cookie,
        host,
        jobConcurrency,
        port,
        publicDir,
        retentionHours,
        storageDir,
    };
}

export function createAppServer(overrides: AppServerOptions = {}) {
    const resolved = resolveOptions(overrides);
    const {
        appBasePath,
        baseUrl,
        cookie,
        host,
        jobConcurrency,
        port,
        publicDir,
        retentionHours,
        storageDir,
    } = resolved;
    const jobsDir = path.join(storageDir, 'jobs');
    const jobQueue = new TaskQueue({ concurrency: jobConcurrency });
    const jobs = new Map<string, JobRecord>();
    const lastPersistedAt = new Map<string, number>();

    mkdirSync(jobsDir, { recursive: true });

    function withBasePath(pathname: string) {
        return `${appBasePath}${pathname}`;
    }

    function stripBasePath(pathname: string) {
        if (!appBasePath) return pathname;
        if (pathname === appBasePath) return '/';
        if (pathname.startsWith(`${appBasePath}/`)) {
            return pathname.slice(appBasePath.length) || '/';
        }
        return null;
    }

    function getJobDir(id: string) {
        return path.join(jobsDir, id);
    }

    function getJobMetaPath(id: string) {
        return path.join(getJobDir(id), 'meta.json');
    }

    function getJobWorkspaceDir(id: string) {
        return path.join(getJobDir(id), 'workspace');
    }

    function getJobArchiveDir(id: string) {
        return path.join(getJobDir(id), 'archive');
    }

    function persistJob(job: JobRecord, force = false) {
        const now = Date.now();
        if (!force) {
            const last = lastPersistedAt.get(job.id) || 0;
            if (now - last < 500) return;
        }
        mkdirSync(getJobDir(job.id), { recursive: true });
        writeFileSync(getJobMetaPath(job.id), JSON.stringify(job, null, 2));
        lastPersistedAt.set(job.id, now);
    }

    function patchJob(id: string, patch: Partial<JobRecord>, force = false) {
        const job = jobs.get(id);
        if (!job) return;
        Object.assign(job, patch, { updatedAt: new Date().toISOString() });
        persistJob(job, force);
    }

    function serializeJob(job: JobRecord) {
        return {
            archiveName: job.archiveName,
            createdAt: job.createdAt,
            currentProblemId: job.currentProblemId,
            downloadedCount: job.downloadedCount,
            downloadedSize: job.downloadedSize,
            error: job.error,
            failedProblemIds: job.failedProblemIds,
            id: job.id,
            kind: job.kind,
            message: job.message,
            problemId: job.problemId,
            progress: job.progress,
            processedProblemCount: job.processedProblemCount,
            rangeEnd: job.rangeEnd,
            rangeStart: job.rangeStart,
            stage: job.stage,
            status: job.status,
            targetLabel: job.targetLabel,
            totalCount: job.totalCount,
            totalProblemCount: job.totalProblemCount,
            totalSize: job.totalSize,
            updatedAt: job.updatedAt,
            warning: job.warning,
            downloadUrl: job.status === 'completed' ? withBasePath(`/api/jobs/${job.id}/download`) : null,
        };
    }

    function loadJobs() {
        for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = getJobMetaPath(entry.name);
            if (!existsSync(metaPath)) continue;
            try {
                const job = JSON.parse(readFileSync(metaPath, 'utf8')) as JobRecord;
                if (job.status === 'queued' || job.status === 'running') {
                    job.status = 'failed';
                    job.stage = 'failed';
                    job.message = 'Server restarted before this task finished.';
                    job.error = 'Server restarted before this task finished.';
                    job.updatedAt = new Date().toISOString();
                    persistJob(job, true);
                }
                jobs.set(job.id, job);
            } catch (error) {
                console.error(`Failed to read job metadata for ${entry.name}:`, error);
            }
        }
    }

    function cleanupExpiredJobs() {
        const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
        for (const [id, job] of jobs.entries()) {
            if (job.status === 'running' || job.status === 'queued') continue;
            const updatedAt = Date.parse(job.updatedAt);
            if (Number.isNaN(updatedAt) || updatedAt > cutoff) continue;
            const dir = getJobDir(id);
            if (existsSync(dir)) {
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch (error) {
                    console.error(`Failed to remove expired job ${id}:`, error);
                    continue;
                }
            }
            jobs.delete(id);
            lastPersistedAt.delete(id);
        }
    }

    async function runJob(id: string) {
        const job = jobs.get(id);
        if (!job) return;
        patchJob(id, {
            message: 'Task is running.',
            progress: 0.02,
            stage: 'running',
            status: 'running',
        }, true);

        try {
            const commonOptions = {
                archiveDir: getJobArchiveDir(id),
                baseUrl: job.baseUrl,
                onProblemProgress(progress: ProblemProgress) {
                    patchJob(id, {
                        currentProblemId: progress.currentProblemId,
                        downloadedCount: progress.downloadedCount,
                        downloadedSize: progress.downloadedSize,
                        failedProblemIds: progress.failedProblemIds,
                        message: progress.message,
                        processedProblemCount: progress.processedProblemCount,
                        progress: progress.progress,
                        stage: progress.stage,
                        totalCount: progress.totalCount,
                        totalProblemCount: progress.totalProblemCount,
                        totalSize: progress.totalSize,
                    });
                },
                outputRoot: getJobWorkspaceDir(id),
                request: {
                    cookie,
                },
            };

            const result = job.kind === 'range'
                ? await downloadProblemArchiveByRange(job.rangeStart!, job.rangeEnd!, commonOptions)
                : await downloadProblemArchiveById(job.problemId!, commonOptions);

            patchJob(id, {
                archiveName: result.archiveName,
                archivePath: result.archivePath,
                failedProblemIds: 'failedProblemIds' in result ? result.failedProblemIds : [],
                message: 'Archive is ready for download.',
                progress: 1,
                stage: 'completed',
                status: 'completed',
                warning: 'failedProblemIds' in result && result.failedProblemIds.length
                    ? `Some problems failed: ${result.failedProblemIds.map((problemId) => `P${problemId}`).join(', ')}`
                    : undefined,
            }, true);
        } catch (error) {
            patchJob(id, {
                error: toErrorMessage(error),
                message: toErrorMessage(error),
                stage: 'failed',
                status: 'failed',
            }, true);
        }
    }

    function json(response: ServerResponse, statusCode: number, payload: unknown) {
        response.statusCode = statusCode;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(payload));
    }

    function text(response: ServerResponse, statusCode: number, content: string) {
        response.statusCode = statusCode;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(content);
    }

    function sendStaticFile(response: ServerResponse, filename: string, method: string) {
        const filePath = path.join(publicDir, filename);
        if (!existsSync(filePath)) {
            text(response, 404, 'Not found');
            return;
        }
        const contentType = filename.endsWith('.js')
            ? 'application/javascript; charset=utf-8'
            : filename.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : 'text/html; charset=utf-8';
        response.statusCode = 200;
        response.setHeader('Content-Type', contentType);
        if (method === 'HEAD') {
            response.end();
            return;
        }
        createReadStream(filePath).pipe(response);
    }

    async function readJsonBody(request: IncomingMessage) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (!chunks.length) return {};
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }

    function createJob(target: ReturnType<typeof parseProblemInput>) {
        const now = new Date().toISOString();
        const job: JobRecord = {
            baseUrl,
            createdAt: now,
            id: randomUUID(),
            kind: target.kind,
            message: 'Task queued.',
            problemId: target.kind === 'single' ? target.problemId : undefined,
            progress: 0,
            rangeEnd: target.kind === 'range' ? target.rangeEnd : undefined,
            rangeStart: target.kind === 'range' ? target.rangeStart : undefined,
            stage: 'queued',
            status: 'queued',
            targetLabel: target.targetLabel,
            updatedAt: now,
        };
        jobs.set(job.id, job);
        persistJob(job, true);
        jobQueue.add(() => runJob(job.id));
        return job;
    }

    loadJobs();
    cleanupExpiredJobs();
    const cleanupTimer = setInterval(cleanupExpiredJobs, 60 * 60 * 1000);
    cleanupTimer.unref();

    const server = createServer(async (request, response) => {
        try {
            const method = request.method || 'GET';
            const isReadMethod = method === 'GET' || method === 'HEAD';
            const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
            const pathname = requestUrl.pathname;
            const strippedPathname = stripBasePath(pathname);

            if (appBasePath && pathname === appBasePath) {
                response.statusCode = 302;
                response.setHeader('Location', `${appBasePath}/`);
                response.end();
                return;
            }

            if (strippedPathname === null) {
                text(response, 404, 'Not found');
                return;
            }

            if (isReadMethod && strippedPathname === '/api/health') {
                json(response, 200, {
                    appBasePath,
                    baseUrl,
                    jobConcurrency,
                    retentionHours,
                    status: 'ok',
                });
                return;
            }

            if (isReadMethod && strippedPathname === '/api/config') {
                json(response, 200, {
                    appBasePath,
                    baseUrl,
                    retentionHours,
                    supportsPrivateProblems: Boolean(cookie),
                });
                return;
            }

            if (isReadMethod && strippedPathname === '/api/jobs') {
                const jobList = [...jobs.values()]
                    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
                    .slice(0, 20)
                    .map(serializeJob);
                json(response, 200, { jobs: jobList });
                return;
            }

            if (method === 'POST' && strippedPathname === '/api/jobs') {
                const body = await readJsonBody(request);
                let target;
                try {
                    if (body.problemInput !== undefined) target = parseProblemInput(body.problemInput);
                    else if (body.problemId !== undefined) target = parseProblemInput(body.problemId);
                    else throw new Error('Please provide problemInput.');
                } catch (error) {
                    json(response, 400, { error: toErrorMessage(error) });
                    return;
                }
                const job = createJob(target);
                json(response, 202, { job: serializeJob(job) });
                return;
            }

            const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(strippedPathname);
            if (isReadMethod && jobMatch) {
                const job = jobs.get(jobMatch[1]);
                if (!job) {
                    json(response, 404, { error: 'Job not found.' });
                    return;
                }
                json(response, 200, { job: serializeJob(job) });
                return;
            }

            const downloadMatch = /^\/api\/jobs\/([^/]+)\/download$/.exec(strippedPathname);
            if (isReadMethod && downloadMatch) {
                const job = jobs.get(downloadMatch[1]);
                if (!job) {
                    json(response, 404, { error: 'Job not found.' });
                    return;
                }
                if (job.status !== 'completed' || !job.archivePath || !existsSync(job.archivePath)) {
                    json(response, 409, { error: 'Archive is not ready yet.' });
                    return;
                }
                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/zip');
                response.setHeader('Content-Disposition', `attachment; filename="${job.archiveName}"`);
                response.setHeader('Content-Length', statSync(job.archivePath).size);
                if (method === 'HEAD') {
                    response.end();
                    return;
                }
                createReadStream(job.archivePath).pipe(response);
                return;
            }

            if (isReadMethod && strippedPathname === '/') {
                sendStaticFile(response, 'index.html', method);
                return;
            }
            if (isReadMethod && strippedPathname === '/app.js') {
                sendStaticFile(response, 'app.js', method);
                return;
            }
            if (isReadMethod && strippedPathname === '/styles.css') {
                sendStaticFile(response, 'styles.css', method);
                return;
            }

            text(response, 404, 'Not found');
        } catch (error) {
            console.error(error);
            json(response, 500, {
                error: toErrorMessage(error),
            });
        }
    });

    server.on('close', () => {
        clearInterval(cleanupTimer);
    });

    return {
        host,
        port,
        server,
        url: normalizeListenUrl(host, port),
    };
}

export async function startServer(overrides: AppServerOptions = {}): Promise<StartedAppServer> {
    const app = createAppServer(overrides);
    if (app.server.listening) {
        return {
            ...app,
            close: () => new Promise((resolve, reject) => {
                app.server.close((error) => {
                    if (error) reject(error);
                    else resolve();
                });
            }),
        };
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            app.server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            app.server.off('error', onError);
            resolve();
        };

        app.server.once('error', onError);
        app.server.once('listening', onListening);
        app.server.listen(app.port, app.host);
    });

    console.log(`loj-download-web is listening on ${app.url}`);

    return {
        ...app,
        close: () => new Promise((resolve, reject) => {
            app.server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
    };
}
