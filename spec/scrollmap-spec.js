const PdfScrollmap = require("../lib/scrollmap");

class FakeSimplemap {
  constructor() {
    this.element = document.createElement("div");
    this.items = null;
  }

  setItems(items) {
    this.items = items;
  }

  destroy() {
    this.element.remove();
  }
}

// MutationObserver delivers on the microtask queue, which the fake spec clock
// does not touch, so draining it a few times is enough to observe the result.
async function drainMutations() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("PdfScrollmap", () => {
  let container, viewer, dataCallback, scrollmap;

  beforeEach(() => {
    container = document.createElement("div");
    viewer = {
      element: document.createElement("iframe"),
      observeScrollMapData(callback) {
        dataCallback = callback;
        return { dispose() {} };
      },
    };
    container.appendChild(viewer.element);

    scrollmap = new PdfScrollmap({ viewers: [viewer] }, FakeSimplemap);
  });

  afterEach(() => {
    scrollmap.destroy();
    container.remove();
  });

  function strip() {
    return scrollmap.viewerContexts.get(viewer).simplemap;
  }

  it("mounts the strip beside the viewer and draws the reported items", () => {
    dataCallback({ items: [{ percent: 10, level: 0 }] });

    expect(strip().element.parentNode).toBe(container);
    expect(strip().element.style.display).toBe("block");
    expect(strip().items).toEqual([{ prc: 10, cls: "marker-pdf-h1" }]);
  });

  it("hides the strip when the pane hides the viewer, and redraws on reshow", async () => {
    dataCallback({ items: [{ percent: 10, level: 0 }] });

    viewer.element.style.display = "none";
    await drainMutations();
    expect(strip().element.style.display).toBe("none");
    expect(strip().items).toEqual([]);

    viewer.element.style.display = "";
    await drainMutations();
    expect(strip().element.style.display).toBe("block");
    expect(strip().items).toEqual([{ prc: 10, cls: "marker-pdf-h1" }]);
  });

  it("keeps the strip hidden when data arrives for a hidden viewer", async () => {
    viewer.element.style.display = "none";
    await drainMutations();

    dataCallback({ items: [{ percent: 25, level: 1 }] });
    expect(strip().element.style.display).toBe("none");

    viewer.element.style.display = "";
    await drainMutations();
    expect(strip().element.style.display).toBe("block");
    expect(strip().items).toEqual([{ prc: 25, cls: "marker-pdf-h2" }]);
  });

  it("ignores style churn that does not change visibility", async () => {
    dataCallback({ items: [{ percent: 10, level: 0 }] });
    const renders = spyOn(scrollmap, "renderViewer").and.callThrough();

    viewer.element.style.pointerEvents = "none";
    await drainMutations();
    expect(renders).not.toHaveBeenCalled();
  });
});
