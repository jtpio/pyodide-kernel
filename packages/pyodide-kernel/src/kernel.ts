import coincident from 'coincident';

import { Remote, wrap } from 'comlink';

import { PromiseDelegate } from '@lumino/coreutils';

import { PageConfig } from '@jupyterlab/coreutils';

import { ILogPayload } from '@jupyterlab/logconsole';

import { Contents, KernelMessage } from '@jupyterlab/services';

import { BaseKernel, IKernel } from '@jupyterlite/kernel';

import {
  ICoincidentPyodideWorkerKernel,
  IComlinkPyodideKernel,
  IPyodideWorkerKernel,
  IRemotePyodideWorkerKernel,
} from './tokens';

import { allJSONUrl, pipliteWheelUrl } from './_pypi';

import {
  DriveContentsProcessor,
  TDriveMethod,
  TDriveRequest,
} from '@jupyterlite/contents';

/**
 * A kernel that executes Python code with Pyodide.
 */
export class PyodideKernel extends BaseKernel implements IKernel {
  /**
   * Instantiate a new PyodideKernel
   *
   * @param options The instantiation options for a new PyodideKernel
   */
  constructor(options: PyodideKernel.IOptions) {
    super(options);
    this._worker = this.initWorker(options);
    this._remoteKernel = this.initRemote(options);
    this._contentsManager = options.contentsManager;
    this._logger = options.logger || (() => {});
  }

  /**
   * Load the worker.
   *
   * ### Note
   *
   * Subclasses must implement this typographically almost _exactly_ for
   * webpack to find it.
   */
  protected initWorker(options: PyodideKernel.IOptions): Worker {
    if (crossOriginIsolated) {
      return new Worker(new URL('./coincident.worker.js', import.meta.url), {
        type: 'module',
      });
    } else {
      return new Worker(new URL('./comlink.worker.js', import.meta.url), {
        type: 'module',
      });
    }
  }

  /**
   * Initialize the remote kernel.
   * Use coincident if crossOriginIsolated, comlink otherwise
   * See the two following issues for more context:
   *  - https://github.com/jupyterlite/jupyterlite/issues/1424
   *  - https://github.com/jupyterlite/pyodide-kernel/pull/126
   */
  protected initRemote(options: PyodideKernel.IOptions): IPyodideWorkerKernel {
    let remote: IComlinkPyodideKernel | ICoincidentPyodideWorkerKernel;
    if (crossOriginIsolated) {
      remote = coincident(this._worker) as ICoincidentPyodideWorkerKernel;
      remote.processLogMessage = this._processLogMessage.bind(this);
      remote.processWorkerMessage = this._processWorkerMessage.bind(this);
      // The coincident worker uses its own filesystem API:
      (remote.processDriveRequest as any) = async <T extends TDriveMethod>(
        data: TDriveRequest<T>,
      ) => {
        if (!DriveContentsProcessor) {
          throw new Error(
            'File system calls over Atomics.wait is only supported with jupyterlite>=0.4.0a3',
          );
        }

        if (this._contentsProcessor === undefined) {
          this._contentsProcessor = new DriveContentsProcessor({
            contentsManager: this._contentsManager,
          });
        }

        return await this._contentsProcessor.processDriveRequest(data);
      };

      ((remote as ICoincidentPyodideWorkerKernel).processStdinRequest as any) =
        async (content: {
          prompt: string;
          password: boolean;
        }): Promise<string | undefined> => {
          const msg = {
            type: 'input_request',
            content,
          };

          this._processWorkerMessage(msg);
          this._inputDelegate = new PromiseDelegate<string | undefined>();
          return await this._inputDelegate.promise;
        };
    } else {
      remote = wrap(this._worker) as IComlinkPyodideKernel;
      // we use the normal postMessage mechanism in the case of comlink
      this._worker.addEventListener('message', (ev) => {
        if (typeof ev?.data?._kernelMessage !== 'undefined') {
          // only process non comlink messages
          this._processWorkerMessage(ev.data._kernelMessage);
        } else if (typeof ev?.data?._logMessage !== 'undefined') {
          this._processLogMessage(ev.data._logMessage);
        }
      });
    }
    const remoteOptions = this.initRemoteOptions(options);
    remote
      .initialize(remoteOptions)
      .then(this._ready.resolve.bind(this._ready))
      .catch((err) => {
        this._logger({
          payload: { type: 'text', level: 'critical', data: err.message },
          kernelId: this.id,
        });
      });
    return remote;
  }

  protected initRemoteOptions(
    options: PyodideKernel.IOptions,
  ): IPyodideWorkerKernel.IOptions {
    const { pyodideUrl } = options;
    const indexUrl = pyodideUrl.slice(0, pyodideUrl.lastIndexOf('/') + 1);
    const baseUrl = PageConfig.getBaseUrl();

    const pipliteUrls = [...(options.pipliteUrls || []), allJSONUrl.default];

    const disablePyPIFallback = !!options.disablePyPIFallback;

    return {
      baseUrl,
      pyodideUrl,
      indexUrl,
      pipliteWheelUrl: options.pipliteWheelUrl || pipliteWheelUrl.default,
      pipliteUrls,
      disablePyPIFallback,
      location: this.location,
      mountDrive: options.mountDrive,
      loadPyodideOptions: options.loadPyodideOptions || {},
      browsingContextId: options.browsingContextId,
      kernelId: this.id,
    };
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._worker.terminate();
    (this._worker as any) = null;
    super.dispose();
  }

  /**
   * A promise that is fulfilled when the kernel is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  private _processLogMessage(payload: ILogPayload): void {
    this._logger({ payload, kernelId: this.id });
  }

  /**
   * Process a message coming from the pyodide web worker.
   *
   * @param msg The worker message to process.
   */
  private _processWorkerMessage(msg: any): void {
    if (!msg.type) {
      return;
    }

    switch (msg.type) {
      case 'stream': {
        const bundle = msg.bundle ?? { name: 'stdout', text: '' };
        this.stream(bundle, msg.parentHeader);
        break;
      }
      case 'input_request': {
        const bundle = msg.content ?? { prompt: '', password: false };
        this.inputRequest(bundle, msg.parentHeader);
        break;
      }
      case 'display_data': {
        const bundle = msg.bundle ?? { data: {}, metadata: {}, transient: {} };
        this.displayData(bundle, msg.parentHeader);
        break;
      }
      case 'update_display_data': {
        const bundle = msg.bundle ?? { data: {}, metadata: {}, transient: {} };
        this.updateDisplayData(bundle, msg.parentHeader);
        break;
      }
      case 'clear_output': {
        const bundle = msg.bundle ?? { wait: false };
        this.clearOutput(bundle, msg.parentHeader);
        break;
      }
      case 'execute_result': {
        const bundle = msg.bundle ?? {
          execution_count: 0,
          data: {},
          metadata: {},
        };
        this.publishExecuteResult(bundle, msg.parentHeader);
        break;
      }
      case 'execute_error': {
        const bundle = msg.bundle ?? { ename: '', evalue: '', traceback: [] };
        this.publishExecuteError(bundle, msg.parentHeader);
        break;
      }
      case 'comm_msg':
      case 'comm_open':
      case 'comm_close': {
        this.handleComm(
          msg.type,
          msg.content,
          msg.metadata,
          msg.buffers,
          msg.parentHeader,
        );
        break;
      }
    }
  }

  /**
   * Handle a kernel_info_request message
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    const content: KernelMessage.IInfoReply = {
      implementation: 'pyodide',
      implementation_version: '0.1.0',
      language_info: {
        codemirror_mode: {
          name: 'python',
          version: 3,
        },
        file_extension: '.py',
        mimetype: 'text/x-python',
        name: 'python',
        nbconvert_exporter: 'python',
        pygments_lexer: 'ipython3',
        version: '3.8',
      },
      protocol_version: '5.3',
      status: 'ok',
      banner: 'A WebAssembly-powered Python kernel backed by Pyodide',
      help_links: [
        {
          text: 'Python (WASM) Kernel',
          url: 'https://pyodide.org',
        },
      ],
    };
    return content;
  }

  /**
   * Handle an `execute_request` message
   *
   * @param msg The parent message.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content'],
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.ready;
    const result = await this._remoteKernel.execute(content, this.parent);
    result.execution_count = this.executionCount;
    return result;
  }

  /**
   * Handle an complete_request message
   *
   * @param msg The parent message.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content'],
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    return await this._remoteKernel.complete(content, this.parent);
  }

  /**
   * Handle an `inspect_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content'],
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    return await this._remoteKernel.inspect(content, this.parent);
  }

  /**
   * Handle an `is_complete_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content'],
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    return await this._remoteKernel.isComplete(content, this.parent);
  }

  /**
   * Handle a `comm_info_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content'],
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    return await this._remoteKernel.commInfo(content, this.parent);
  }

  /**
   * Send an `comm_open` message.
   *
   * @param msg - The comm_open message.
   */
  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    return await this._remoteKernel.commOpen(msg, this.parent);
  }

  /**
   * Send an `comm_msg` message.
   *
   * @param msg - The comm_msg message.
   */
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    return await this._remoteKernel.commMsg(msg, this.parent);
  }

  /**
   * Send an `comm_close` message.
   *
   * @param close - The comm_close message.
   */
  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    return await this._remoteKernel.commClose(msg, this.parent);
  }

  /**
   * Send an `input_reply` message.
   *
   * @param content - The content of the reply.
   */
  async inputReply(content: KernelMessage.IInputReplyMsg['content']): Promise<void> {
    const value = 'value' in content ? content.value : undefined;
    this._inputDelegate.resolve(value);
  }

  private _contentsManager: Contents.IManager;
  private _logger: (options: { payload: ILogPayload; kernelId: string }) => void;
  private _contentsProcessor: DriveContentsProcessor | undefined;
  private _worker: Worker;
  private _remoteKernel:
    | IRemotePyodideWorkerKernel
    | Remote<IRemotePyodideWorkerKernel>;
  private _ready = new PromiseDelegate<void>();
  private _inputDelegate = new PromiseDelegate<string | undefined>();
}

/**
 * A namespace for PyodideKernel statics.
 */
export namespace PyodideKernel {
  /**
   * The instantiation options for a Pyodide kernel
   */
  export interface IOptions extends IKernel.IOptions {
    /**
     * The URL to fetch Pyodide.
     */
    pyodideUrl: string;

    /**
     * The URL to fetch piplite
     */
    pipliteWheelUrl?: string;

    /**
     * The URLs from which to attempt PyPI API requests
     */
    pipliteUrls: string[];

    /**
     * Do not try pypi.org if `piplite.install` fails against local URLs
     */
    disablePyPIFallback: boolean;

    /**
     * Whether or not to mount the Emscripten drive
     */
    mountDrive: boolean;

    /**
     * additional options to provide to `loadPyodide`
     * @see https://pyodide.org/en/stable/usage/api/js-api.html#globalThis.loadPyodide
     */
    loadPyodideOptions: Record<string, any> & {
      lockFileURL: string;
      packages: string[];
    };

    /**
     * The Jupyterlite content manager
     */
    contentsManager: Contents.IManager;

    /**
     * A unique ID to identify the origin of this request.
     * This should be provided by `IServiceWorkerManager` and is used to
     * identify the browsing context from which the request originated.
     */
    browsingContextId?: string;

    /**
     * The logger function to use for logging messages from the kernel.
     */
    logger?: (options: { payload: ILogPayload; kernelId: string }) => void;
  }
}
