const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Viewer = require("../lib/viewer");
const { FileState } = require("lumine");

describe("PDF file observation", () => {
  let directory, filePath, viewer;
  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-watch-"));
    filePath = path.join(directory, "document.pdf");
    fs.writeFileSync(filePath, "%PDF-1.7\n%%EOF\n");
    viewer = new Viewer(filePath, "#page=3");
    await viewer.file.ready;
  });
  afterEach(async () => {
    const file = viewer.file;
    viewer.destroy();
    await file.closed;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  it("keeps observing its original filename after an external rename", async () => {
    fs.renameSync(filePath, path.join(directory, "external.pdf"));
    await globalThis.conditionPromise(() => viewer.getFileState() === FileState.REMOVED);
    expect(viewer.getPath()).toBe(filePath);
    fs.writeFileSync(filePath, "%PDF-1.7\nrecreated\n%%EOF\n");
    await globalThis.conditionPromise(() => viewer.getFileState() === FileState.UNMODIFIED);
  });
  it("retargets an explicit move while preserving its navigation hash", async () => {
    const target = path.join(directory, "moved.pdf");
    const rename = { oldPath: filePath, newPath: target, isDirectory: false };
    const move = lumine.workspace.beginFileMove([rename]);
    const previous = viewer.file;
    fs.renameSync(filePath, target);
    await move.complete([rename]);
    await previous.closed;
    expect(viewer.getPath()).toBe(target);
    expect(viewer.hash).toBe("#page=3");
    expect(viewer.getFileState()).toBe(FileState.UNMODIFIED);
  });
});
