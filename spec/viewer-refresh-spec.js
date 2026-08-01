const fs = require("fs");
const os = require("os");
const path = require("path");
const Viewer = require("../lib/viewer");

describe("PDF viewer auto-refresh", () => {
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
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a watcher notification when the opened PDF has not changed", () => {
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
