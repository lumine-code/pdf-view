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
  });

  it("removes the whole item view on destroy", () => {
    jasmine.attachToDOM(viewer.element);
    const element = viewer.element;
    viewer.destroy();
    viewer = null;
    expect(element.parentNode).toBeNull();
  });
});
