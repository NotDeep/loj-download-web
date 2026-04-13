export class TaskQueue {
    private readonly concurrency: number;
    private activeCount = 0;
    private readonly pending: Array<() => void> = [];

    constructor(options: { concurrency?: number } = {}) {
        const concurrency = options.concurrency ?? 1;
        this.concurrency = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1;
    }

    add<T>(task: () => Promise<T> | T): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const run = () => {
                this.activeCount += 1;

                Promise.resolve()
                    .then(task)
                    .then(resolve, reject)
                    .finally(() => {
                        this.activeCount -= 1;
                        const next = this.pending.shift();
                        if (next) next();
                    });
            };

            if (this.activeCount < this.concurrency) {
                run();
                return;
            }

            this.pending.push(run);
        });
    }
}
