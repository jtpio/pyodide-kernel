// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * A WebWorker entrypoint that uses coincident to handle postMessage details
 */
import coincident from 'coincident';

import {
  ContentsAPI,
  DriveFS,
  TDriveMethod,
  TDriveRequest,
  TDriveResponse,
} from '@jupyterlite/contents';

import { ICoincidentPyodideWorkerKernel, IPyodideWorkerKernel } from './tokens';

import { PyodideRemoteKernel } from './worker';

const workerAPI = coincident(self) as ICoincidentPyodideWorkerKernel;

/**
 * An Emscripten-compatible synchronous Contents API using shared array buffers.
 */
export class SharedBufferContentsAPI extends ContentsAPI {
  request<T extends TDriveMethod>(data: TDriveRequest<T>): TDriveResponse<T> {
    return workerAPI.processDriveRequest(data);
  }
}

/**
 * A custom drive implementation which uses shared array buffers (via coincident) if available
 */
class PyodideDriveFS extends DriveFS {
  createAPI(options: DriveFS.IOptions): ContentsAPI {
    return new SharedBufferContentsAPI(options);
  }
}

export class PyodideCoincidentKernel extends PyodideRemoteKernel {
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

      const driveFS = new PyodideDriveFS({
        FS: FS as any,
        PATH,
        ERRNO_CODES,
        baseUrl,
        driveName: this._driveName,
        mountpoint,
      });
      FS.mkdirTree(mountpoint);
      FS.mount(driveFS, {}, mountpoint);
      FS.chdir(mountpoint);
      this._driveFS = driveFS;
    }
  }

  protected sendInputRequest(prompt: string, password: boolean): string | undefined {
    // Input request via SharedArrayBuffer.
    return workerAPI.processStdinRequest({ prompt, password });
  }
}

const worker = new PyodideCoincidentKernel();

const sendWorkerMessage = workerAPI.processWorkerMessage.bind(workerAPI);
worker.registerWorkerMessageCallback(sendWorkerMessage);

const logMessage = workerAPI.processLogMessage.bind(workerAPI);
worker.registerLogMessageCallback(logMessage);

workerAPI.initialize = worker.initialize.bind(worker);
workerAPI.execute = worker.execute.bind(worker);
workerAPI.complete = worker.complete.bind(worker);
workerAPI.inspect = worker.inspect.bind(worker);
workerAPI.isComplete = worker.isComplete.bind(worker);
workerAPI.commInfo = worker.commInfo.bind(worker);
workerAPI.commOpen = worker.commOpen.bind(worker);
workerAPI.commMsg = worker.commMsg.bind(worker);
workerAPI.commClose = worker.commClose.bind(worker);
workerAPI.inputReply = worker.inputReply.bind(worker);
