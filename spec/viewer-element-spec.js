const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const Viewer = require("../lib/viewer");

describe("Viewer element", () => {
  let dir, file, viewer, surfaceFrame;

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
    surfaceFrame?.remove();
    surfaceFrame = null;
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

  it("rebuilds its iframe in each surface realm and restores its complete view state", async () => {
    const state = {
      page: 7,
      zoom: "page-width",
      scrollTop: 321,
      scrollLeft: 12,
      hash: "#page=7&zoom=page-width",
      sidebarOpen: true,
      sidebarView: 2,
    };
    const frameFixture = path.join(dir, "surface-frame.html");
    fs.writeFileSync(
      frameFixture,
      `
      <script>
        let state = {page: 1, zoom: "auto", scrollTop: 0, scrollLeft: 0, hash: ""};
        addEventListener("message", event => {
          if (event.data.type === "get-view-state") {
            parent.postMessage({type: "viewState", requestId: event.data.requestId, state}, "*");
          } else if (event.data.type === "restore-view-state") {
            state = event.data.state;
            parent.postMessage({type: "viewStateRestored", requestId: event.data.requestId}, "*");
          }
        });
        parent.postMessage({type: "ready"}, "*");
      </script>
    `,
    );
    const frameSource = pathToFileURL(frameFixture).href;
    spyOn(viewer, "frameSource").and.returnValue(frameSource);
    jasmine.attachToDOM(viewer.element);
    viewer.ready = false;
    viewer.frame.src = frameSource;
    await viewer.whenReady();
    await viewer.restoreViewState(state);
    expect(await viewer.requestViewState()).toEqual(state);
    const initialFrame = viewer.frame;

    surfaceFrame = document.createElement("iframe");
    document.body.appendChild(surfaceFrame);
    const detachContext = Object.freeze({
      id: "pdf-detach",
      reason: "detach",
      item: viewer,
      from: null,
      to: null,
      signal: new AbortController().signal,
    });
    const detach = await viewer.beginWindowSurfaceTransition(detachContext);
    surfaceFrame.contentDocument.body.appendChild(viewer.element);
    await detach.commit(detachContext);

    const detachedFrame = viewer.frame;
    expect(initialFrame.isConnected).toBe(false);
    expect(detachedFrame).not.toBe(initialFrame);
    expect(detachedFrame.ownerDocument).toBe(surfaceFrame.contentDocument);
    expect(await viewer.requestViewState()).toEqual(state);
    expect(typeof detachedFrame.pdfViewerRedispatchKeyboardEvent).toBe("function");

    const handler = jasmine.createSpy("surfaceMessage");
    viewer.messageHandlers.surfaceTest = handler;
    surfaceFrame.contentWindow.dispatchEvent(
      new surfaceFrame.contentWindow.MessageEvent("message", {
        source: detachedFrame.contentWindow,
        data: { type: "surfaceTest" },
      }),
    );
    expect(handler).toHaveBeenCalled();

    const attachContext = Object.freeze({
      id: "pdf-attach",
      reason: "attach",
      item: viewer,
      from: null,
      to: null,
      signal: new AbortController().signal,
    });
    const attach = await viewer.beginWindowSurfaceTransition(attachContext);
    document.body.appendChild(viewer.element);
    await attach.commit(attachContext);

    expect(detachedFrame.isConnected).toBe(false);
    expect(viewer.frame).not.toBe(detachedFrame);
    expect(viewer.frame.ownerDocument).toBe(document);
    expect(await viewer.requestViewState()).toEqual(state);
  });
});
