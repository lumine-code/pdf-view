const fs = require("fs");
const os = require("os");
const path = require("path");
const Viewer = require("../lib/viewer");

describe("PDF view auto-refresh", () => {
  let dir, file, viewer;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-refresh-")));
    file = path.join(dir, "document.pdf");
    fs.writeFileSync(file, "%PDF-1.7\ninitial\n%%EOF\n");

    viewer = Object.create(Viewer.prototype);
    viewer.file = { getPath: () => file };
    viewer.fileStableTimeout = null;
    viewer.refreshTimeout = null;
    viewer.pendingFileState = null;
    viewer.loadedFileState = viewer.getFileState();
    viewer.loadErrorRetries = 0;
    viewer.lastFailedFileState = null;
    viewer.debug = false;
    viewer.refresh = jasmine.createSpy("refresh");
  });

  afterEach(() => {
    if (viewer?.fileStableTimeout) {
      clearTimeout(viewer.fileStableTimeout);
    }
    if (viewer?.refreshTimeout) {
      clearTimeout(viewer.refreshTimeout);
    }
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("ignores a watcher notification when the opened PDF has not changed", () => {
    viewer.scheduleStableRefresh();

    expect(viewer.refresh).not.toHaveBeenCalled();
    expect(viewer.fileStableTimeout).toBeNull();
  });

  it("ignores a metadata-only change, like the read that loading the PDF performs", () => {
    const mtime = new Date(2026, 0, 1, 12, 0, 0);
    fs.utimesSync(file, mtime, mtime);
    viewer.loadedFileState = viewer.getFileState();

    // Loading the PDF reads the file, which updates its access time — and on
    // Windows the ChangeTime (ctimeMs) with it — without touching the contents.
    fs.utimesSync(file, new Date(2026, 0, 1, 13, 0, 0), mtime);
    viewer.scheduleStableRefresh();

    expect(viewer.refresh).not.toHaveBeenCalled();
    expect(viewer.fileStableTimeout).toBeNull();
  });

  it("refreshes once after a changed PDF remains stable", () => {
    fs.writeFileSync(file, "%PDF-1.7\nupdated document contents\n%%EOF\n");

    viewer.scheduleStableRefresh();
    globalThis.advanceClock(199);
    expect(viewer.refresh).not.toHaveBeenCalled();

    globalThis.advanceClock(1);
    expect(viewer.refresh).toHaveBeenCalledTimes(1);
    expect(viewer.fileStatesEqual(viewer.loadedFileState, viewer.getFileState())).toBe(true);
  });

  it("restarts the quiet period when another watcher event arrives", () => {
    fs.writeFileSync(file, "%PDF-1.7\nfirst update\n%%EOF\n");
    viewer.scheduleStableRefresh();
    globalThis.advanceClock(150);

    fs.writeFileSync(file, "%PDF-1.7\nsecond, longer update\n%%EOF\n");
    viewer.scheduleStableRefresh();
    globalThis.advanceClock(199);
    expect(viewer.refresh).not.toHaveBeenCalled();

    globalThis.advanceClock(1);
    expect(viewer.refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers from a failed document load without a watcher event", () => {
    // The file on disk is complete and unchanged since reload() fingerprinted
    // it -- the load failed for another reason (a transient lock). No watcher
    // event will ever arrive, so the loadError report alone must get back to a
    // refresh once the stability loop finds the file stable and valid.
    viewer.handleLoadErrorMessage();
    expect(viewer.loadedFileState).toBeNull();

    globalThis.advanceClock(199);
    expect(viewer.refresh).not.toHaveBeenCalled();
    globalThis.advanceClock(1);
    expect(viewer.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the same file state fails three times", () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      viewer.handleLoadErrorMessage();
      globalThis.advanceClock(200);
    }
    expect(viewer.refresh).toHaveBeenCalledTimes(3);

    // The fourth failure of identical bytes is a broken file, not a race.
    viewer.handleLoadErrorMessage();
    globalThis.advanceClock(200);
    expect(viewer.refresh).toHaveBeenCalledTimes(3);
    expect(viewer.fileStableTimeout).toBeNull();
  });

  it("grants a changed file a fresh retry budget", () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      viewer.handleLoadErrorMessage();
      globalThis.advanceClock(200);
    }
    expect(viewer.refresh).toHaveBeenCalledTimes(3);

    // The build wrote new bytes: the old failure's budget no longer applies.
    fs.writeFileSync(file, "%PDF-1.7\nrewritten by the build\n%%EOF\n");
    viewer.handleLoadErrorMessage();
    globalThis.advanceClock(200);
    expect(viewer.refresh).toHaveBeenCalledTimes(4);
  });

  it("waits for a mid-write file to settle before the recovery refresh", () => {
    // The failed fetch read a truncated file and the build is still writing:
    // the loop must hold the refresh until the trailer is on disk.
    fs.writeFileSync(file, "%PDF-1.7\ntruncated middle of a write");
    viewer.handleLoadErrorMessage();
    globalThis.advanceClock(200);
    expect(viewer.refresh).not.toHaveBeenCalled();

    fs.writeFileSync(file, "%PDF-1.7\nthe write completed\n%%EOF\n");
    // The first check sees the fingerprint move and re-arms; only the second
    // finds it stable. advanceClock fires no timer armed during the advance,
    // so each check needs its own step.
    globalThis.advanceClock(200);
    expect(viewer.refresh).not.toHaveBeenCalled();
    globalThis.advanceClock(200);
    expect(viewer.refresh).toHaveBeenCalledTimes(1);
  });

  it("debounces delayed refreshes after the last detected change", () => {
    viewer.ready = true;
    viewer.autoTime = 1000;
    viewer.clearNavigationState = jasmine.createSpy("clearNavigationState");
    viewer.sendMessage = jasmine.createSpy("sendMessage");
    viewer.refresh = Viewer.prototype.refresh;

    viewer.refresh();
    globalThis.advanceClock(750);
    viewer.refresh();
    globalThis.advanceClock(999);
    expect(viewer.sendMessage).not.toHaveBeenCalled();

    globalThis.advanceClock(1);
    expect(viewer.sendMessage).toHaveBeenCalledTimes(1);
    expect(viewer.sendMessage).toHaveBeenCalledWith({ type: "refresh", filePath: file });
  });
});
