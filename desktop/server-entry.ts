import { mkdirSync } from 'fs';
import path from 'path';
import { startServer } from '../server';

interface DesktopLaunchOptions {
    baseUrl: string;
    host: string;
    port: number;
    retentionHours: number;
    storageDir: string;
}

function parseIntegerOption(name: string, value: string | undefined, fallback: number) {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return parsed;
}

function parseArgs(argv: string[]): DesktopLaunchOptions {
    const defaults: DesktopLaunchOptions = {
        baseUrl: 'https://loj.ac',
        host: '127.0.0.1',
        port: 32145,
        retentionHours: 24,
        storageDir: path.resolve(process.cwd(), 'storage'),
    };

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        const next = argv[index + 1];

        if (current === '--port') {
            defaults.port = parseIntegerOption('port', next, defaults.port);
            index += 1;
            continue;
        }

        if (current === '--host') {
            if (!next) throw new Error('host value is required.');
            defaults.host = next;
            index += 1;
            continue;
        }

        if (current === '--base-url') {
            if (!next) throw new Error('base-url value is required.');
            defaults.baseUrl = next;
            index += 1;
            continue;
        }

        if (current === '--storage-dir') {
            if (!next) throw new Error('storage-dir value is required.');
            defaults.storageDir = path.resolve(next);
            index += 1;
            continue;
        }

        if (current === '--retention-hours') {
            defaults.retentionHours = parseIntegerOption('retention-hours', next, defaults.retentionHours);
            index += 1;
            continue;
        }

        throw new Error(`Unknown option: ${current}`);
    }

    return defaults;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    mkdirSync(options.storageDir, { recursive: true });

    const app = await startServer({
        baseUrl: options.baseUrl,
        host: options.host,
        port: options.port,
        publicDir: path.resolve(__dirname, '../public'),
        retentionHours: options.retentionHours,
        storageDir: options.storageDir,
    });

    const shutdown = () => {
        app.close()
            .catch((error) => {
                console.error('Failed to stop desktop backend cleanly:', error);
            })
            .finally(() => {
                process.exit(0);
            });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
