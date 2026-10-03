const fs = require("fs");

const RESPONSE_TIMEOUT = 15000;
const DOCUMENT_MESSAGES = new Set([
  "documentLoaded",
  "pdfjsOutline",
  "visibleOutlineItems",
  "currentOutlineItem",
  "scrollMapData",
]);

function aborted() {
  const error = new Error("PDF document replacement was cancelled");
  error.name = "AbortError";
  return error;
}

// Preparation leaves the current PDF and its metadata intact. The adapter
// retains that document until the host accepts the initialized replacement,
// allowing an aborted or failed commit to restore it in the same iframe.
module.exports = class DocumentReplacement {
  constructor(owner) {
    this.owner = owner;
    this.operation = null;
    this.waitingCount = 0;
  }

  get pending() {
    return this.operation !== null || this.waitingCount > 0;
  }

  async replace(filePath, hash, { signal } = {}) {
    if (signal?.aborted || this.owner.destroyed) throw aborted();
    while (this.operation) {
      const previous = this.operation;
      this.waitingCount++;
      this.cancel();
      try {
        await previous.finished;
      } finally {
        this.waitingCount--;
      }
      if (signal?.aborted || this.owner.destroyed) throw aborted();
    }
    if (!this.owner.canReplaceDocument()) return Promise.resolve(false);
    let stats;
    try {
      stats = fs.statSync(filePath);
      if (!stats.isFile()) throw new Error(`Not a PDF file: ${filePath}`);
    } catch (error) {
      return Promise.reject(error);
    }
    const observation = this.owner.prepareFileObservation?.(filePath);
    const controller = this.owner.refreshController;
    controller.cancelTimers();
    const requestId = ++controller.nextRequestId;
    return new Promise((resolve, reject) => {
      const operation = {
        requestId,
        filePath,
        hash,
        signal,
        resolve,
        reject,
        fingerprint: { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino },
        messages: [],
        error: null,
        observation,
        sent: false,
      };
      operation.finished = new Promise((done) => {
        operation.onFinished = done;
      });
      this.operation = operation;
      operation.onAbort = () => this.cancel(aborted());
      signal?.addEventListener("abort", operation.onAbort, { once: true });
      operation.timer = setTimeout(() => {
        this.cancel(new Error(`Timed out opening PDF: ${filePath}`));
      }, RESPONSE_TIMEOUT);
      const prepare = () => {
        if (this.operation !== operation || operation.error) return;
        if (signal?.aborted) return this.cancel();
        operation.sent = this.owner.sendMessage({
          type: "prepareDocument",
          filePath,
          hash,
          requestId,
        });
        if (!operation.sent) {
          this.finish(operation, new Error(`Unable to contact the PDF viewer: ${filePath}`));
        }
      };
      if (observation) {
        observation.ready.then(prepare, (error) => {
          if (this.operation === operation) this.finish(operation, error);
        });
      } else {
        prepare();
      }
    });
  }

  handleMessage(data) {
    const operation = this.operation;
    if (!operation || data?.requestId !== operation.requestId) return false;
    if (DOCUMENT_MESSAGES.has(data.type)) {
      if (!operation.error) operation.messages.push(data);
      return true;
    }
    switch (data.type) {
      case "documentPrepared":
        if (operation.signal?.aborted || operation.error) this.cancel();
        else if (
          !this.owner.sendMessage({ type: "commitDocument", requestId: operation.requestId })
        ) {
          this.cancel(new Error(`Unable to commit PDF: ${operation.filePath}`));
        }
        return true;
      case "documentCommitted": {
        if (operation.signal?.aborted || operation.error) {
          this.cancel();
          return true;
        }
        try {
          if (!fs.statSync(operation.filePath).isFile()) {
            throw new Error(`Not a PDF file: ${operation.filePath}`);
          }
        } catch (error) {
          this.cancel(error);
          return true;
        }
        // Nothing below yields: metadata publication and accepting the new
        // document are the commit boundary for the workspace's AbortSignal.
        if (!this.owner.sendMessage({ type: "acceptDocument", requestId: operation.requestId })) {
          this.cancel(new Error(`Unable to accept PDF: ${operation.filePath}`));
          return true;
        }
        const observation = operation.observation;
        operation.observation = null;
        this.cleanup(operation);
        this.owner.setFile(operation.filePath, operation.hash, observation);
        const controller = this.owner.refreshController;
        controller.currentRequestId = operation.requestId;
        controller.sentDiskFingerprint = operation.fingerprint;
        controller.inFlightRequest = {
          requestId: operation.requestId,
          fingerprint: operation.fingerprint,
        };
        controller.onDocumentLoaded({ requestId: operation.requestId });
        for (const message of operation.messages) {
          if (message.type !== "documentLoaded")
            this.owner.messageHandlers[message.type]?.(message);
        }
        operation.resolve(true);
        return true;
      }
      case "documentCancelled":
        this.finish(operation, operation.error || aborted());
        return true;
      case "documentReplacementError":
        this.finish(
          operation,
          new Error(data.message || `Unable to open PDF: ${operation.filePath}`),
        );
        return true;
      case "documentReplacementDeclined":
        if (operation.signal?.aborted || operation.error) {
          this.finish(operation, operation.error || aborted());
        } else {
          this.cleanup(operation);
          operation.resolve(false);
          this.owner.refreshController.scheduleStableRefresh();
        }
        return true;
      default:
        return false;
    }
  }

  cancel(error = aborted()) {
    const operation = this.operation;
    if (!operation || operation.error) return;
    operation.error = error;
    clearTimeout(operation.timer);
    if (!operation.sent) return this.finish(operation, error);
    this.owner.sendMessage({ type: "cancelDocument", requestId: operation.requestId });
    operation.timer = setTimeout(() => this.finish(operation, error), RESPONSE_TIMEOUT);
  }

  cleanup(operation) {
    clearTimeout(operation.timer);
    operation.signal?.removeEventListener("abort", operation.onAbort);
    if (this.operation === operation) this.operation = null;
    operation.observation?.dispose();
    operation.observation = null;
    operation.onFinished();
  }

  finish(operation, error) {
    this.cleanup(operation);
    operation.reject(error);
    if (!this.owner.destroyed) this.owner.refreshController.scheduleStableRefresh();
  }

  destroy() {
    const operation = this.operation;
    if (!operation) return;
    this.owner.sendMessage({ type: "cancelDocument", requestId: operation.requestId });
    this.finish(operation, aborted());
  }

  cancelForReload() {
    // Navigating the iframe destroys its adapter; no recovery acknowledgement
    // can arrive from that generation, so release callers before navigation.
    this.destroy();
  }
};
