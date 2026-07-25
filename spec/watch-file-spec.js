const { watchFile } = require("atom");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The PDF viewer watched its backing .pdf with the removed synchronous atom
// `File` API (onDidChange/onDidDelete/onDidRename + getPath). Lumine replaced
// File with the async watchFile. These specs pin the parts of the watchFile
// contract the viewer relies on. The handle exposes its emitter so events can be
// synthesized without depending on filesystem timing, and owns a native watcher
// that must be disposed (the viewer adds an explicit Disposable for that).
describe("watchFile (pdf viewer file watcher migration)", () => {
  let dir, file, handle;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-watch-")));
    file = path.join(dir, "document.pdf");
    fs.writeFileSync(file, "%PDF-1.7\n%%EOF\n");
  });

  afterEach(() => {
    if (handle) {
      handle.dispose();
      handle = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is exported from the atom module as a function", () => {
    expect(typeof watchFile).toBe("function");
  });

  it("returns a handle with the File-compatible surface the viewer uses", () => {
    handle = watchFile(file);
    expect(typeof handle.getPath).toBe("function");
    expect(handle.getPath()).toBe(file);
    expect(typeof handle.onDidChange).toBe("function");
    expect(typeof handle.onDidRename).toBe("function");
    expect(typeof handle.onDidDelete).toBe("function");
    expect(typeof handle.dispose).toBe("function");
    expect(typeof handle.getStartPromise).toBe("function");
  });

  it("fires onDidChange and onDidDelete via its emitter", () => {
    handle = watchFile(file);
    let changed = 0;
    let deleted = 0;
    handle.onDidChange(() => {
      changed += 1;
    });
    handle.onDidDelete(() => {
      deleted += 1;
    });

    handle.emitter.emit("did-change");
    handle.emitter.emit("did-delete");
    expect(changed).toBe(1);
    expect(deleted).toBe(1);
  });

  it("arms without throwing and resolves its start promise", async () => {
    handle = watchFile(file);
    await handle.getStartPromise();
  });
});
