import { create } from 'fancy-progress';
import { run } from './index';

const totalReporter = create('* Total', 'green');
const problemReporter = create('Problem', 'red');

function handleFatalError(error: unknown) {
    console.error(error);
    setTimeout(() => {
        console.error(error);
        process.exit(1);
    }, 1000);
}

process.on('unhandledRejection', handleFatalError);
process.on('uncaughtException', handleFatalError);

if (!process.argv[2]) {
    console.log('loj-download <url>');
} else {
    run(process.argv[2], {
        onProblemProgress(progress) {
            problemReporter.update(progress.progress, progress.message);
        },
        onTotalProgress(progress, message) {
            totalReporter.update(progress, message);
        },
    }).catch(handleFatalError);
}
