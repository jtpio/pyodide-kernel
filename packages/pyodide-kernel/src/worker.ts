// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type Pyodide from 'pyodide';

import type { ILogPayload } from '@jupyterlab/logconsole';

import { KernelMessage } from '@jupyterlab/services';

import type { DriveFS } from '@jupyterlite/contents';

import type { IPyodideWorkerKernel } from './tokens';

export abstract class PyodideRemoteKernel {
  constructor() {
    this._initialized = new Promise((resolve, reject) => {
      this._initializer = { resolve, reject };
    });
  }

  /**
   * Accept the URLs from the host
   **/
  async initialize(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    this._options = options;

    if (options.location.includes(':')) {
      const parts = options.location.split(':');
      this._driveName = parts[0];
      this._localPath = parts[1];
    } else {
      this._driveName = '';
      this._localPath = options.location;
    }

    await this.initRuntime(options);
    await this.initFilesystem(options);
    await this.initPackageManager(options);
    await this.initKernel(options);
    await this.initGlobals(options);
    this._initializer?.resolve();
  }

  protected async initRuntime(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    const { pyodideUrl, indexUrl } = options;
    let loadPyodide: typeof Pyodide.loadPyodide;
    if (pyodideUrl.endsWith('.mjs')) {
      // note: this does not work at all in firefox
      const pyodideModule: typeof Pyodide = await import(
        /* webpackIgnore: true */ pyodideUrl
      );
      loadPyodide = pyodideModule.loadPyodide;
    } else {
      importScripts(pyodideUrl);
      loadPyodide = (self as any).loadPyodide;
    }
    this._pyodide = await loadPyodide({
      indexURL: indexUrl,
      ...options.loadPyodideOptions,
    });
    // @ts-expect-error: pyodide._api is private
    this._pyodide._api.on_fatal = async (e: any) => {
      let error = '';
      if (e.name === 'Exit') {
        error = 'Pyodide has exited and can no longer be used.';
      } else {
        error = `Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.
The cause of the error was: ${e.name}
${e.message}
Stack trace:
${e.stack}`;
      }
      this._logMessage({
        type: 'text',
        level: 'critical',
        data: error,
      });
    };

    const log = (msg: string) => {
      console.log(msg);
      this._logMessage({ type: 'text', level: 'info', data: msg });
    };

    const err = (msg: string) => {
      console.error(msg);
      this._logMessage({ type: 'text', level: 'critical', data: msg });
    };

    // Workaround for being able to get information about packages being loaded by Pyodide
    // See discussion in https://github.com/pyodide/pyodide/discussions/5512
    const origLoadPackage = this._pyodide.loadPackage;
    this._pyodide.loadPackage = (pkgs, options) =>
      origLoadPackage(pkgs, {
        // Use custom callbacks to surface messages from Pyodide
        messageCallback: (msg: string) => log(msg),
        errorCallback: (msg: string) => {
          err(msg);
        },
        ...options,
      });
  }

  protected async initPackageManager(
    options: IPyodideWorkerKernel.IOptions,
  ): Promise<void> {
    if (!this._options) {
      throw new Error('Uninitialized');
    }

    const { pipliteWheelUrl, disablePyPIFallback, pipliteUrls, loadPyodideOptions } =
      this._options;

    const preloaded = (loadPyodideOptions || {}).packages || [];

    if (!preloaded.includes('micropip')) {
      await this._pyodide.loadPackage(['micropip']);
    }

    if (!preloaded.includes('piplite')) {
      await this._pyodide.runPythonAsync(`
      import micropip
      await micropip.install('${pipliteWheelUrl}', keep_going=True)
    `);
    }

    // get piplite early enough to impact pyodide-kernel dependencies
    await this._pyodide.runPythonAsync(`
      import piplite.piplite
      piplite.piplite._PIPLITE_DISABLE_PYPI = ${disablePyPIFallback ? 'True' : 'False'}
      piplite.piplite._PIPLITE_URLS = ${JSON.stringify(pipliteUrls)}
    `);
  }

  protected async initKernel(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    const preloaded = (options.loadPyodideOptions || {}).packages || [];

    const toLoad = [
      'ssl',
      'sqlite3',
      'ipykernel',
      'comm',
      'pyodide_kernel',
      'jedi',
      'ipython',
    ];

    const scriptLines: string[] = [];

    // use piplite for packages that weren't pre-loaded
    for (const pkgName of toLoad) {
      if (!preloaded.includes(pkgName)) {
        scriptLines.push(`await piplite.install('${pkgName}', keep_going=True)`);
      }
    }

    // import the kernel
    scriptLines.push('import pyodide_kernel');

    // cd to the kernel location
    if (options.mountDrive && this._localPath) {
      scriptLines.push('import os', `os.chdir("${this._localPath}")`);
    }

    // from this point forward, only use piplite (but not %pip)
    await this._pyodide.runPythonAsync(scriptLines.join('\n'));
  }

  protected async initGlobals(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    const { globals } = this._pyodide;
    this._kernel = globals.get('pyodide_kernel').kernel_instance.copy();
    this._stdout_stream = globals.get('pyodide_kernel').stdout_stream.copy();
    this._stderr_stream = globals.get('pyodide_kernel').stderr_stream.copy();
    this._interpreter = this._kernel.interpreter.copy();
    this._interpreter.send_comm = this.sendComm.bind(this);
  }

  /**
   * Setup custom Emscripten FileSystem
   */
  protected async initFilesystem(
    options: IPyodideWorkerKernel.IOptions,
  ): Promise<void> {
    if (options.mountDrive) {
      const mountpoint = '/drive';
      const { FS, PATH, ERRNO_CODES } = this._pyodide;
      const { baseUrl } = options;
      const { DriveFS } = await import('@jupyterlite/contents');

      const driveFS = new DriveFS({
        FS: FS as any,
        PATH,
        ERRNO_CODES,
        baseUrl,
        driveName: this._driveName,
        mountpoint,
        browsingContextId: this._browsingContextId,
      });
      FS.mkdirTree(mountpoint);
      FS.mount(driveFS, {}, mountpoint);
      FS.chdir(mountpoint);
      this._driveFS = driveFS;
    }
  }

  /**
   * Recursively convert a Map to a JavaScript object
   * @param obj A Map, Array, or other  object to convert
   */
  mapToObject(obj: any) {
    const out: any = obj instanceof Array ? [] : {};
    obj.forEach((value: any, key: string) => {
      out[key] =
        value instanceof Map || value instanceof Array
          ? this.mapToObject(value)
          : value;
    });
    return out;
  }

  /**
   * Format the response from the Pyodide evaluation.
   *
   * @param res The result object from the Pyodide evaluation
   */
  formatResult(res: any): any {
    if (!(res instanceof this._pyodide.ffi.PyProxy)) {
      return res;
    }
    // TODO: this is a bit brittle
    const m = res.toJs();
    const results = this.mapToObject(m);
    return results;
  }

  /**
   * Register the callback function to send messages from the worker back to the main thread.
   *
   * @param callback the callback to register
   */
  registerWorkerMessageCallback(callback: (msg: any) => void): void {
    this._sendWorkerMessage = callback;
  }

  /**
   * Register the callback function to log messages from the worker back to the main thread.
   *
   * @param callback the callback to register
   */
  registerLogMessageCallback(callback: (msg: any) => void): void {
    this._logMessage = callback;
  }

  /**
   * Makes sure pyodide is ready before continuing, and cache the parent message.
   */
  async setup(parent: any): Promise<void> {
    await this._initialized;
    this._kernel._parent_header = this._pyodide.toPy(parent);
  }

  /**
   * Execute code with the interpreter.
   *
   * @param content The incoming message with the code to execute.
   */
  async execute(content: any, parent: any) {
    await this.setup(parent);

    const publishExecutionResult = (
      prompt_count: any,
      data: any,
      metadata: any,
    ): void => {
      const bundle = {
        execution_count: prompt_count,
        data: this.formatResult(data),
        metadata: this.formatResult(metadata),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'execute_result',
      });
    };

    const publishExecutionError = (ename: any, evalue: any, traceback: any): void => {
      const bundle = {
        ename: ename,
        evalue: evalue,
        traceback: traceback,
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'execute_error',
      });
    };

    const clearOutputCallback = (wait: boolean): void => {
      const bundle = {
        wait: this.formatResult(wait),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'clear_output',
      });
    };

    const displayDataCallback = (data: any, metadata: any, transient: any): void => {
      const bundle = {
        data: this.formatResult(data),
        metadata: this.formatResult(metadata),
        transient: this.formatResult(transient),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'display_data',
      });
    };

    const updateDisplayDataCallback = (
      data: any,
      metadata: any,
      transient: any,
    ): void => {
      const bundle = {
        data: this.formatResult(data),
        metadata: this.formatResult(metadata),
        transient: this.formatResult(transient),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'update_display_data',
      });
    };

    const publishStreamCallback = (name: any, text: any): void => {
      const bundle = {
        name: this.formatResult(name),
        text: this.formatResult(text),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'stream',
      });
    };

    this._stdout_stream.publish_stream_callback = publishStreamCallback;
    this._stderr_stream.publish_stream_callback = publishStreamCallback;
    this._interpreter.display_pub.clear_output_callback = clearOutputCallback;
    this._interpreter.display_pub.display_data_callback = displayDataCallback;
    this._interpreter.display_pub.update_display_data_callback =
      updateDisplayDataCallback;
    this._interpreter.displayhook.publish_execution_result = publishExecutionResult;
    this._interpreter.input = this.input.bind(this);
    this._interpreter.getpass = this.getpass.bind(this);

    const res = await this._kernel.run(content.code);
    const results = this.formatResult(res);

    if (results['status'] === 'error') {
      publishExecutionError(results['ename'], results['evalue'], results['traceback']);
    }

    return results;
  }

  /**
   * Complete the code submitted by a user.
   *
   * @param content The incoming message with the code to complete.
   */
  async complete(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.complete(content.code, content.cursor_pos);
    const results = this.formatResult(res);
    return results;
  }

  /**
   * Inspect the code submitted by a user.
   *
   * @param content The incoming message with the code to inspect.
   */
  async inspect(
    content: { code: string; cursor_pos: number; detail_level: 0 | 1 },
    parent: any,
  ) {
    await this.setup(parent);

    const res = this._kernel.inspect(
      content.code,
      content.cursor_pos,
      content.detail_level,
    );
    const results = this.formatResult(res);
    return results;
  }

  /**
   * Check code for completeness submitted by a user.
   *
   * @param content The incoming message with the code to check.
   */
  async isComplete(content: { code: string }, parent: any) {
    await this.setup(parent);

    const res = this._kernel.is_complete(content.code);
    const results = this.formatResult(res);
    return results;
  }

  /**
   * Respond to the commInfoRequest.
   *
   * @param content The incoming message with the comm target name.
   */
  async commInfo(
    content: any,
    parent: any,
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    await this.setup(parent);

    const res = this._kernel.comm_info(content.target_name);
    const results = this.formatResult(res);

    return {
      comms: results,
      status: 'ok',
    };
  }

  /**
   * Respond to the commOpen.
   *
   * @param content The incoming message with the comm open.
   */
  async commOpen(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.comm_manager.comm_open(
      this._pyodide.toPy(null),
      this._pyodide.toPy(null),
      this._pyodide.toPy(content),
    );
    const results = this.formatResult(res);

    return results;
  }

  /**
   * Respond to the commMsg.
   *
   * @param content The incoming message with the comm msg.
   */
  async commMsg(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.comm_manager.comm_msg(
      this._pyodide.toPy(null),
      this._pyodide.toPy(null),
      this._pyodide.toPy(content),
    );
    const results = this.formatResult(res);

    return results;
  }

  /**
   * Respond to the commClose.
   *
   * @param content The incoming message with the comm close.
   */
  async commClose(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.comm_manager.comm_close(
      this._pyodide.toPy(null),
      this._pyodide.toPy(null),
      this._pyodide.toPy(content),
    );
    const results = this.formatResult(res);

    return results;
  }

  /**
   * Resolve the input request by getting back the reply from the main thread
   *
   * @param content The incoming message with the reply
   */
  async inputReply(content: any, parent: any) {
    // Should never be called as input_reply messages are returned via service worker
    // or SharedArrayBuffer.
  }

  /**
   * Send a input request to the front-end and block until the reply is received.
   *
   * @param prompt the text to show at the prompt
   * @param password Is the request for a password?
   * @returns String value from the input reply message, or undefined if there is none.
   */
  protected abstract sendInputRequest(
    prompt: string,
    password: boolean,
  ): string | undefined;

  getpass(prompt: string): string | undefined {
    prompt = typeof prompt === 'undefined' ? '' : prompt;
    return this.sendInputRequest(prompt, true);
  }

  input(prompt: string): string | undefined {
    prompt = typeof prompt === 'undefined' ? '' : prompt;
    return this.sendInputRequest(prompt, false);
  }

  /**
   * Send a comm message to the front-end.
   *
   * @param type The type of the comm message.
   * @param content The content.
   * @param metadata The metadata.
   * @param ident The ident.
   * @param buffers The binary buffers.
   */
  async sendComm(type: string, content: any, metadata: any, ident: any, buffers: any) {
    this._sendWorkerMessage({
      type: type,
      content: this.formatResult(content),
      metadata: this.formatResult(metadata),
      ident: this.formatResult(ident),
      buffers: this.formatResult(buffers),
      parentHeader: this.formatResult(this._kernel._parent_header)['header'],
    });
  }

  /**
   * Initialization options.
   */
  protected _options: IPyodideWorkerKernel.IOptions | null = null;
  /**
   * A promise that resolves when all initiaization is complete.
   */
  protected _initialized: Promise<void>;
  private _initializer: {
    reject: () => void;
    resolve: () => void;
  } | null = null;
  protected _pyodide: Pyodide.PyodideInterface = null as any;
  /** TODO: real typing */
  protected _localPath = '';
  protected _driveName = '';
  protected _browsingContextId: string | undefined;
  protected _kernel: any;
  protected _interpreter: any;
  protected _stdout_stream: any;
  protected _stderr_stream: any;
  protected _driveFS: DriveFS | null = null;
  protected _sendWorkerMessage: (msg: any) => void = () => {};
  protected _logMessage: (msg: ILogPayload) => void = () => {};
}
