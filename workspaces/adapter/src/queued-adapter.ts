import npmlog from 'npmlog';
import PQueue from 'p-queue';
import { TrackerGroup } from 'are-we-there-yet';
import type { Logger, InputOutputAdapter, PromptAnswers, PromptQuestions, QueuedAdapter as QueuedAdapterApi } from '@yeoman/types';
import { TerminalAdapter, type TerminalAdapterOptions } from './adapter.js';

// eslint-disable-next-line @typescript-eslint/naming-convention
const BLOCKING_PRIORITY = 10;
// eslint-disable-next-line @typescript-eslint/naming-convention
const PROMPT_PRIORITY = 10;
// eslint-disable-next-line @typescript-eslint/naming-convention
const LOG_PRIORITY = 20;
// eslint-disable-next-line @typescript-eslint/naming-convention
const MAIN_ADAPTER_PRIORITY = 1000;

type Task<TaskResultType> =
  | ((adapter: InputOutputAdapter) => PromiseLike<TaskResultType>)
  | ((adapter: InputOutputAdapter) => TaskResultType);

type QueuedAdapterOptions = TerminalAdapterOptions & {
  queue?: PQueue;
  delta?: number;
  adapter?: InputOutputAdapter;
};

type ProgressCallback<ReturnType> = (progress: { step: (prefix: string, message: string, ...args: any[]) => void }) => ReturnType;
type ProgressOptions = { disabled?: boolean; name?: string };

export type AdapterWithProgress = QueuedAdapterApi & {
  progress<ReturnType>(fn: ProgressCallback<ReturnType>, options?: ProgressOptions): Promise<void | ReturnType>;
};

export class QueuedAdapter implements AdapterWithProgress {
  #queue: PQueue;
  actualAdapter: InputOutputAdapter;
  delta: number;
  log: Logger;
  #nextChildPriority: number;

  /**
   * `TerminalAdapter` is the default implementation of `Adapter`, an abstraction
   * layer that defines the I/O interactions.
   *
   * It provides a CLI interaction
   *
   * @constructor
   * @param {terminalAdapter}          [import('./adapter.js').default]
   */
  constructor(options?: QueuedAdapterOptions) {
    const { adapter, queue, delta, ...adapterOptions } = options ?? {};
    this.#queue = queue ?? new PQueue({ concurrency: 1 });
    this.actualAdapter = adapter ?? new TerminalAdapter(adapterOptions);

    // Deffered logger
    const defferredLogger = (...args: any[]) => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.queueLog(() => {
        this.actualAdapter.log(...args);
      });
      return defferredLogger;
    };

    Object.assign(defferredLogger, this.actualAdapter.log);
    defferredLogger.write = (...args: any[]) => {
      this.queueLog(() => {
        this.actualAdapter.log.write(...args);
      }).catch(console.error);
      return defferredLogger;
    };

    this.log = defferredLogger as unknown as Logger;
    this.delta = (delta ?? MAIN_ADAPTER_PRIORITY) * 100;
    this.#nextChildPriority = MAIN_ADAPTER_PRIORITY - 1;
  }

  newAdapter(delta?: number) {
    return new QueuedAdapter({ adapter: this.actualAdapter, delta: delta ?? this.#nextChildPriority--, queue: this.#queue });
  }

  close() {
    this.actualAdapter.close();
    this.#queue.clear();
  }

  /**
   * Prompt a user for one or more questions and pass
   * the answer(s) to the provided callback.
   *
   * It shares its interface with `Base.prompt`
   *
   * (Defined inside the constructor to keep interfaces separated between
   * instances)
   *
   * @param {Object|Object[]} questions
   * @param {Object} [answers] Answers to be passed to inquirer
   * @return {Object} promise answers
   */

  async prompt<A extends PromptAnswers = PromptAnswers>(questions: PromptQuestions<A>, initialAnswers?: Partial<A>): Promise<A> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.#queue.add(async () => this.actualAdapter.prompt(questions, initialAnswers), {
      priority: PROMPT_PRIORITY + this.delta,
    }) as any;
  }

  async onIdle() {
    return this.#queue.onIdle();
  }

  /**
   * Basic queue is recommended for blocking calls.
   * @param fn
   * @returns
   */
  async queue<TaskResultType>(fn: Task<TaskResultType>): Promise<TaskResultType | void> {
    return this.#queue.add(() => fn(this.actualAdapter), { priority: BLOCKING_PRIORITY + this.delta });
  }

  /**
   * Log has a highest priority and should be not blocking.
   * @param fn
   * @returns
   */
  async queueLog<TaskResultType>(fn: Task<TaskResultType>): Promise<TaskResultType | void> {
    return this.#queue.add(() => fn(this.actualAdapter), { priority: LOG_PRIORITY + this.delta });
  }

  /**
   * Progress is blocking, but will be skipped if the queue is not empty.
   * @param callback
   * @param options
   * @returns
   */
  async progress<ReturnType>(
    fn: (progress: { step: (prefix: string, message: string, ...args: any[]) => void }) => ReturnType,
    options?: { disabled?: boolean; name: string },
  ): Promise<void | ReturnType> {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (this.#queue.size > 0 || this.#queue.pending > 0 || options?.disabled || (npmlog as any).progressEnabled) {
      // Don't show progress if not empty
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return fn({ step() {} });
    }

    let log: any;
    try {
      npmlog.tracker = new TrackerGroup();
      npmlog.enableProgress();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      log = (npmlog as any).newItem(options?.name);
    } catch {
      npmlog.disableProgress();
      log = undefined;
    }

    const step = (prefix: string, message: string, ...args: any[]) => {
      if (log) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        log.completeWork(10);
        npmlog.info(prefix, message, ...args);
      }
    };

    return this.queue(() => fn({ step })).finally(() => {
      if (log) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        log.finish();
        npmlog.disableProgress();
      }
    });
  }
}
