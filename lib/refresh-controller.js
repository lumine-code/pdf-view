const fs = require("fs");

const STABILITY_DELAY = 200;
const MAX_RECOVERY_ATTEMPTS = 3;

module.exports = class RefreshController {
  constructor(owner, { fileSystem = fs } = {}) {
    this.owner = owner;
    this.fileSystem = fileSystem;
    this.fileStableTimeout = null;
    this.refreshTimeout = null;
    this.observedDiskFingerprint = null;
    this.pendingDiskFingerprint = null;
    this.sentDiskFingerprint = null;
    this.loadedDiskFingerprint = null;
    this.lastFailedDiskFingerprint = null;
    this.loadErrorRetries = 0;
    this.pendingRequest = null;
    this.needsStabilityCheck = false;
    this.recovering = false;
    this.inFlightRequest = null;
    this.currentRequestId = null;
    this.nextRequestId = 0;
    this.destroyed = false;
  }

  get pendingRefresh() {
    return this.pendingRequest !== null || this.needsStabilityCheck;
  }

  get stopped() {
    return this.destroyed || this.owner.destroyed;
  }

  get paused() {
    return this.owner.autoRefreshPausedByBuild || this.owner.fileOperationDepth > 0;
  }

  getDiskFingerprint() {
    try {
      const stats = this.fileSystem.statSync(this.owner.filePath);
      return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
    } catch {
      return null;
    }
  }

  diskFingerprintsEqual(left, right) {
    if (left == null || right == null) return left == null && right == null;
    return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
  }

  isCurrentRequest(requestId) {
    return !this.stopped && requestId != null && requestId === this.currentRequestId;
  }

  cancelTimers() {
    clearTimeout(this.fileStableTimeout);
    clearTimeout(this.refreshTimeout);
    this.fileStableTimeout = null;
    this.refreshTimeout = null;
  }

  preferenceChanged() {
    if (this.stopped) return;
    if (this.owner.autoRefresh) {
      this.scheduleStableRefresh();
    } else if (!this.recovering) {
      clearTimeout(this.fileStableTimeout);
      this.fileStableTimeout = null;
      this.pendingDiskFingerprint = null;
      this.needsStabilityCheck = false;
      if (this.pendingRequest?.kind === "automatic") {
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = null;
        this.pendingRequest = null;
      }
    }
  }

  resetForFile() {
    this.cancelTimers();
    this.observedDiskFingerprint = this.getDiskFingerprint();
    this.pendingDiskFingerprint = null;
    this.sentDiskFingerprint = null;
    this.loadedDiskFingerprint = null;
    this.lastFailedDiskFingerprint = null;
    this.loadErrorRetries = 0;
    this.pendingRequest = null;
    this.needsStabilityCheck = false;
    this.recovering = false;
    this.inFlightRequest = null;
    this.currentRequestId = null;
  }

  beginReload() {
    this.resetForFile();
    this.owner.ready = false;
    return this.recordRequest(this.observedDiskFingerprint);
  }

  recordRequest(fingerprint) {
    const requestId = ++this.nextRequestId;
    this.currentRequestId = requestId;
    this.sentDiskFingerprint = fingerprint;
    this.inFlightRequest = { requestId, fingerprint };
    return requestId;
  }

  onReady(data) {
    if (!this.isCurrentRequest(data?.requestId)) return false;
    this.owner.ready = true;
    if (this.pendingRequest) this.scheduleSend(this.pendingRequest);
    else if (this.needsStabilityCheck) this.scheduleStableRefresh();
    return true;
  }

  onDocumentLoaded(data) {
    if (!this.isCurrentRequest(data?.requestId) || !this.inFlightRequest) return false;
    this.loadedDiskFingerprint = this.inFlightRequest.fingerprint;
    this.inFlightRequest = null;
    this.lastFailedDiskFingerprint = null;
    this.loadErrorRetries = 0;
    this.recovering = false;
    this.observedDiskFingerprint = this.getDiskFingerprint();
    if (!this.diskFingerprintsEqual(this.observedDiskFingerprint, this.loadedDiskFingerprint)) {
      this.scheduleStableRefresh();
    }
    return true;
  }

  onLoadError(data) {
    if (!this.isCurrentRequest(data?.requestId) || !this.inFlightRequest) return false;
    const failedFingerprint = this.inFlightRequest.fingerprint;
    this.loadErrorRetries = this.diskFingerprintsEqual(
      failedFingerprint,
      this.lastFailedDiskFingerprint,
    )
      ? this.loadErrorRetries + 1
      : 1;
    this.lastFailedDiskFingerprint = failedFingerprint;
    this.inFlightRequest = null;
    this.sentDiskFingerprint = null;
    this.loadedDiskFingerprint = null;
    this.recovering = true;
    this.scheduleStableRefresh();
    return true;
  }

  fileUnavailable() {
    this.cancelTimers();
    this.observedDiskFingerprint = null;
    this.pendingDiskFingerprint = null;
    this.needsStabilityCheck = false;
    if (this.pendingRequest?.kind !== "manual") this.pendingRequest = null;
  }

  scheduleStableRefresh() {
    if (this.stopped) return;
    if (this.pendingRequest?.kind === "manual") {
      if (!this.paused) this.scheduleSend(this.pendingRequest);
      return;
    }
    if (!this.owner.autoRefresh && !this.recovering) return;
    clearTimeout(this.fileStableTimeout);
    this.fileStableTimeout = null;
    const fingerprint = this.getDiskFingerprint();
    this.observedDiskFingerprint = fingerprint;
    if (!fingerprint) {
      this.fileUnavailable();
      return;
    }
    if (
      this.diskFingerprintsEqual(fingerprint, this.loadedDiskFingerprint) ||
      (this.inFlightRequest &&
        this.diskFingerprintsEqual(fingerprint, this.inFlightRequest.fingerprint)) ||
      (this.loadErrorRetries > MAX_RECOVERY_ATTEMPTS &&
        this.diskFingerprintsEqual(fingerprint, this.lastFailedDiskFingerprint))
    ) {
      this.pendingDiskFingerprint = null;
      this.needsStabilityCheck = false;
      return;
    }
    this.pendingDiskFingerprint = fingerprint;
    this.needsStabilityCheck = true;
    if (this.paused) return;
    this.fileStableTimeout = setTimeout(() => this.checkFileStability(), STABILITY_DELAY);
  }

  checkFileStability() {
    this.fileStableTimeout = null;
    if (this.stopped || this.paused) return;
    if (!this.owner.autoRefresh && !this.recovering) {
      this.needsStabilityCheck = false;
      return;
    }
    const fingerprint = this.getDiskFingerprint();
    this.observedDiskFingerprint = fingerprint;
    if (!fingerprint) {
      this.fileUnavailable();
      return;
    }
    if (!this.diskFingerprintsEqual(fingerprint, this.pendingDiskFingerprint)) {
      this.scheduleStableRefresh();
      return;
    }
    this.needsStabilityCheck = false;
    this.pendingDiskFingerprint = null;
    // PDF.js decides whether stable bytes form a document. A header/trailer
    // heuristic rejects documents it can read, and cannot prove a write finished.
    this.scheduleSend({
      kind: this.recovering ? "recovery" : "automatic",
      fingerprint,
      immediate: false,
    });
  }

  refresh() {
    return this.scheduleSend({ kind: "manual", fingerprint: null, immediate: false });
  }

  refreshNow() {
    return this.scheduleSend({ kind: "manual", fingerprint: null, immediate: true });
  }

  scheduleSend(request) {
    if (this.stopped) return;
    // A user request keeps priority over an automatic check of the same file.
    if (this.pendingRequest?.kind === "manual" && request.kind !== "manual") return;
    clearTimeout(this.refreshTimeout);
    this.refreshTimeout = null;
    this.pendingRequest = request;
    if (!this.owner.ready || this.paused) return;
    if (request.immediate) return this.sendPending();
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = null;
      this.sendPending();
    }, this.owner.autoTime);
    return this.refreshTimeout;
  }

  sendPending() {
    if (this.stopped || !this.pendingRequest || !this.owner.ready || this.paused) return;
    const request = this.pendingRequest;
    this.pendingRequest = null;
    if (request.kind === "automatic" && !this.owner.autoRefresh) return;
    const fingerprint = this.getDiskFingerprint();
    if (
      request.kind !== "manual" &&
      !this.diskFingerprintsEqual(fingerprint, request.fingerprint)
    ) {
      this.scheduleStableRefresh();
      return;
    }
    const requestId = this.recordRequest(fingerprint);
    this.owner.clearNavigationState();
    this.owner.sendMessage({ type: "refresh", filePath: this.owner.filePath, requestId });
    return requestId;
  }

  pauseAutoRefresh() {
    if (this.stopped) return;
    this.owner.autoRefreshPausedByBuild = true;
    this.cancelTimers();
  }

  resumeAutoRefresh() {
    if (this.stopped || !this.owner.autoRefreshPausedByBuild) return;
    this.owner.autoRefreshPausedByBuild = false;
    if (this.pendingRequest?.kind === "manual") this.scheduleSend(this.pendingRequest);
    else this.scheduleStableRefresh();
  }

  destroy() {
    this.destroyed = true;
    this.cancelTimers();
    this.pendingRequest = null;
    this.needsStabilityCheck = false;
    this.inFlightRequest = null;
    this.currentRequestId = null;
  }
};
