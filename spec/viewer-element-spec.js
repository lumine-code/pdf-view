const fs = require("fs");
const os = require("os");
const path = require("path");
const Viewer = require("../lib/viewer");

describe("Viewer element", () => {
  let dir, file, viewer;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-element-")));
    file = path.join(dir, "document.pdf");
    fs.writeFileSync(file, "%PDF-1.7\ncontent\n%%EOF\n");
    viewer = new Viewer(file, "");
  });

  afterEach(() => {
    // Destroying a focused iframe leaves the window with no focused frame,
    // which strands every later spec's focusTestWindow on a host with no
    // window manager -- hand focus back to the top document first.
    if (viewer && document.activeElement === viewer.frame) {
      viewer.frame.blur();
    }
    viewer?.destroy();
    viewer = null;
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("is a wrapper item view holding the PDF.js iframe", () => {
    expect(viewer.element.tagName).toBe("DIV");
    expect(viewer.element.classList.contains("pdf-view")).toBe(true);
    expect(viewer.frame.tagName).toBe("IFRAME");
    expect(viewer.frame.parentNode).toBe(viewer.element);
    expect(viewer.frame.classList.contains("pdf-view-frame")).toBe(true);
  });

  it("keeps the redispatch hook on the iframe, where frameElement resolves", () => {
    expect(typeof viewer.frame.pdfViewerRedispatchKeyboardEvent).toBe("function");
    expect(viewer.element.pdfViewerRedispatchKeyboardEvent).toBeUndefined();
  });

  it("forwards item-view focus to the iframe", () => {
    jasmine.attachToDOM(viewer.element);
    viewer.element.focus();
    expect(document.activeElement).toBe(viewer.frame);

    viewer.frame.blur();
    expect(document.activeElement).not.toBe(viewer.frame);
  });

  it("removes the whole item view on destroy", () => {
    jasmine.attachToDOM(viewer.element);
    const element = viewer.element;
    viewer.destroy();
    viewer = null;
    expect(element.parentNode).toBeNull();
  });

  it("reports removed until the backing file becomes available again", () => {
    const states = [];
    viewer.onDidChangeFileState((state) => states.push(state));

    viewer.file.emitter.emit("did-delete");
    expect(viewer.getFileState()).toBe(lumine.FileState.REMOVED);

    viewer.file.emitter.emit("did-change");
    expect(viewer.getFileState()).toBe(lumine.FileState.UNMODIFIED);
    expect(states).toEqual([lumine.FileState.REMOVED, lumine.FileState.UNMODIFIED]);
  });
});
