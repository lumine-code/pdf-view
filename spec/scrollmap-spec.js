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

describe("PdfScrollmap", () => {
  let viewer, dataCallback, scrollmap;

  beforeEach(() => {
    viewer = {
      element: document.createElement("div"),
      observeScrollMapData(callback) {
        dataCallback = callback;
        return { dispose() {} };
      },
    };

    scrollmap = new PdfScrollmap({ viewers: [viewer] }, FakeSimplemap);
  });

  afterEach(() => {
    scrollmap.destroy();
  });

  function strip() {
    return scrollmap.viewerContexts.get(viewer).simplemap;
  }

  it("mounts the strip inside the item view and draws the reported items", () => {
    dataCallback({ items: [{ percent: 10, level: 0 }] });

    expect(strip().element.parentNode).toBe(viewer.element);
    expect(strip().element.style.display).toBe("block");
    expect(strip().items).toEqual([{ prc: 10, cls: "marker-pdf-h1" }]);
  });

  it("removes the strip with the viewer", () => {
    dataCallback({ items: [{ percent: 10, level: 0 }] });
    const element = strip().element;

    scrollmap.removeViewer(viewer);

    expect(element.parentNode).toBeNull();
    expect(scrollmap.viewerContexts.has(viewer)).toBe(false);
  });
});
