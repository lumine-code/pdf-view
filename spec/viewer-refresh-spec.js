const RefreshController = require("../lib/refresh-controller");

describe("PDF view refresh lifecycle", () => {
  let owner, controller, disk;

  const loadedRequest = () => {
    const requestId = controller.beginReload();
    controller.onReady({ requestId });
    controller.onDocumentLoaded({ requestId });
    return requestId;
  };
  const settleAndSend = () => {
    globalThis.advanceClock(200);
    globalThis.advanceClock(owner.autoTime);
  };
  const lastRequest = () => owner.sendMessage.calls.mostRecent().args[0].requestId;

  beforeEach(() => {
    disk = { size: 100, mtimeMs: 1, ino: 7 };
    owner = {
      filePath: "document.pdf",
      ready: false,
      autoRefresh: true,
      autoTime: 1000,
      autoRefreshPausedByBuild: false,
      destroyed: false,
      fileOperationDepth: 0,
      clearNavigationState: jasmine.createSpy("clearNavigationState"),
      sendMessage: jasmine.createSpy("sendMessage"),
    };
    controller = new RefreshController(owner, {
      fileSystem: {
        statSync: () => {
          if (!disk) throw new Error("File unavailable");
          return { ...disk };
        },
      },
    });
  });

  afterEach(() => controller.destroy());

  it("acknowledges bytes only when PDF.js confirms the document loaded", () => {
    const requestId = controller.beginReload();
    controller.onReady({ requestId });
    expect(controller.loadedDiskFingerprint).toBeNull();
    expect(controller.sentDiskFingerprint).toEqual(disk);
    controller.onDocumentLoaded({ requestId });
    expect(controller.loadedDiskFingerprint).toEqual(disk);
  });

  it("ignores watcher notifications for loaded or currently loading bytes", () => {
    const requestId = controller.beginReload();
    controller.scheduleStableRefresh();
    expect(controller.fileStableTimeout).toBeNull();
    controller.onDocumentLoaded({ requestId });
    controller.scheduleStableRefresh();
    expect(controller.fileStableTimeout).toBeNull();
    expect(owner.sendMessage).not.toHaveBeenCalled();
  });

  it("debounces after the last change without prematurely acknowledging bytes", () => {
    loadedRequest();
    disk = { ...disk, size: 200, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    globalThis.advanceClock(150);
    disk = { ...disk, size: 300, mtimeMs: 3 };
    controller.scheduleStableRefresh();
    globalThis.advanceClock(199);
    expect(owner.sendMessage).not.toHaveBeenCalled();
    globalThis.advanceClock(1);
    globalThis.advanceClock(999);
    expect(owner.sendMessage).not.toHaveBeenCalled();
    globalThis.advanceClock(1);
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
    expect(owner.sendMessage).toHaveBeenCalledWith({
      type: "refresh",
      filePath: "document.pdf",
      requestId: lastRequest(),
    });
    expect(controller.loadedDiskFingerprint.mtimeMs).toBe(1);
    controller.onDocumentLoaded({ requestId: lastRequest() });
    expect(controller.loadedDiskFingerprint).toEqual(disk);
  });

  it("retains a stable file change until the iframe becomes ready", () => {
    const requestId = controller.beginReload();
    disk = { ...disk, size: 200, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    settleAndSend();
    expect(owner.sendMessage).not.toHaveBeenCalled();
    expect(controller.pendingRefresh).toBe(true);
    expect(controller.loadedDiskFingerprint).toBeNull();
    controller.onReady({ requestId });
    globalThis.advanceClock(owner.autoTime);
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
    expect(controller.sentDiskFingerprint).toEqual(disk);
  });

  it("checks stability again when bytes change during the configured delay", () => {
    loadedRequest();
    disk = { ...disk, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    globalThis.advanceClock(200);
    disk = { ...disk, mtimeMs: 3 };
    globalThis.advanceClock(owner.autoTime);
    expect(owner.sendMessage).not.toHaveBeenCalled();
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
    expect(controller.sentDiskFingerprint.mtimeMs).toBe(3);
  });

  it("cancels an existing delayed refresh while the source builds", () => {
    loadedRequest();
    disk = { ...disk, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    globalThis.advanceClock(200);
    controller.pauseAutoRefresh();
    globalThis.advanceClock(5000);
    expect(owner.sendMessage).not.toHaveBeenCalled();
    expect(owner.autoRefresh).toBe(true);
    expect(controller.refreshTimeout).toBeNull();
    disk = { ...disk, size: 300, mtimeMs: 3 };
    controller.resumeAutoRefresh();
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
    expect(controller.sentDiskFingerprint).toEqual(disk);
  });

  it("cancels a pending stability check during a build", () => {
    loadedRequest();
    disk = { ...disk, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    controller.pauseAutoRefresh();
    globalThis.advanceClock(5000);
    expect(controller.fileStableTimeout).toBeNull();
    expect(owner.sendMessage).not.toHaveBeenCalled();
    controller.resumeAutoRefresh();
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("allows a queued manual refresh with automatic refresh disabled", () => {
    const requestId = controller.beginReload();
    owner.autoRefresh = false;
    controller.refreshNow();
    expect(owner.sendMessage).not.toHaveBeenCalled();
    controller.onReady({ requestId });
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("defers a manual refresh until a build finishes", () => {
    loadedRequest();
    owner.autoRefresh = false;
    controller.pauseAutoRefresh();
    controller.refreshNow();
    expect(owner.sendMessage).not.toHaveBeenCalled();
    controller.resumeAutoRefresh();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("defers manual refresh during a file operation and flushes on reconciliation", () => {
    loadedRequest();
    owner.fileOperationDepth++;
    controller.cancelTimers();
    controller.refreshNow();
    expect(owner.sendMessage).not.toHaveBeenCalled();
    owner.fileOperationDepth--;
    controller.scheduleStableRefresh();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("cancels automatic work when its preference is disabled", () => {
    loadedRequest();
    disk = { ...disk, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    globalThis.advanceClock(200);
    owner.autoRefresh = false;
    controller.preferenceChanged();
    globalThis.advanceClock(owner.autoTime);
    expect(owner.sendMessage).not.toHaveBeenCalled();
    expect(controller.pendingRefresh).toBe(false);
    owner.autoRefresh = true;
    controller.preferenceChanged();
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("limits parser recovery to three attempts for unchanged bytes", () => {
    let requestId = controller.beginReload();
    controller.onReady({ requestId });
    owner.autoRefresh = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(controller.onLoadError({ requestId })).toBe(true);
      settleAndSend();
      requestId = lastRequest();
    }
    expect(owner.sendMessage).toHaveBeenCalledTimes(3);
    controller.onLoadError({ requestId });
    controller.scheduleStableRefresh();
    globalThis.advanceClock(10000);
    expect(owner.sendMessage).toHaveBeenCalledTimes(3);
    expect(controller.fileStableTimeout).toBeNull();
    expect(controller.refreshTimeout).toBeNull();
    expect(controller.sentDiskFingerprint).toBeNull();
  });

  it("gives changed bytes a new recovery budget after an earlier file failed", () => {
    let requestId = controller.beginReload();
    controller.onReady({ requestId });
    owner.autoRefresh = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      controller.onLoadError({ requestId });
      settleAndSend();
      requestId = lastRequest();
    }
    controller.onLoadError({ requestId });
    disk = { ...disk, size: 300, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    settleAndSend();
    requestId = lastRequest();
    expect(owner.sendMessage).toHaveBeenCalledTimes(4);
    controller.onLoadError({ requestId });
    expect(controller.loadErrorRetries).toBe(1);
  });

  it("asks PDF.js to parse stable bytes without a header or EOF heuristic", () => {
    loadedRequest();
    disk = { ...disk, size: 0, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
    expect(controller.sentDiskFingerprint.size).toBe(0);
  });

  it("waits for the watcher when a file disappears during recovery", () => {
    const requestId = controller.beginReload();
    controller.onReady({ requestId });
    owner.autoRefresh = false;
    disk = null;
    controller.onLoadError({ requestId });
    globalThis.advanceClock(10000);
    expect(controller.fileStableTimeout).toBeNull();
    expect(owner.sendMessage).not.toHaveBeenCalled();
    disk = { size: 300, mtimeMs: 2, ino: 8 };
    controller.scheduleStableRefresh();
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects stale acknowledgements, errors and readiness after a newer request", () => {
    const previous = loadedRequest();
    disk = { ...disk, mtimeMs: 2 };
    controller.refreshNow();
    const current = lastRequest();
    expect(controller.onDocumentLoaded({ requestId: previous })).toBe(false);
    expect(controller.onLoadError({ requestId: previous })).toBe(false);
    expect(controller.onReady({ requestId: previous })).toBe(false);
    expect(controller.loadedDiskFingerprint.mtimeMs).toBe(1);
    expect(controller.onDocumentLoaded({ requestId: current })).toBe(true);
    expect(controller.loadedDiskFingerprint.mtimeMs).toBe(2);
  });

  it("detects changes made while the previous request was loading", () => {
    const requestId = controller.beginReload();
    controller.onReady({ requestId });
    disk = { ...disk, mtimeMs: 2 };
    controller.onDocumentLoaded({ requestId });
    settleAndSend();
    expect(owner.sendMessage).toHaveBeenCalledTimes(1);
    expect(controller.sentDiskFingerprint.mtimeMs).toBe(2);
  });

  it("destroys pending work and ignores late completion callbacks", () => {
    const requestId = loadedRequest();
    disk = { ...disk, mtimeMs: 2 };
    controller.scheduleStableRefresh();
    controller.destroy();
    globalThis.advanceClock(10000);
    expect(owner.sendMessage).not.toHaveBeenCalled();
    expect(controller.onDocumentLoaded({ requestId })).toBe(false);
    expect(controller.onLoadError({ requestId })).toBe(false);
    expect(controller.pendingRefresh).toBe(false);
  });
});
