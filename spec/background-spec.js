const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF background and paper edges", () => {
  let main, directory, viewer;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-background-"));
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    const observation = viewer?.fileObservation;
    await lumine.packages.deactivatePackage("pdf-view");
    await observation?.closed;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    viewer = null;
  });

  async function open() {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 2 }));
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
  }

  it("follows the theme behind the white paper", async () => {
    await open();
    viewer.element.style.setProperty("--app-background-color", "rgb(12, 34, 56)");
    expect(getComputedStyle(viewer.viewport).backgroundColor).toBe("rgb(12, 34, 56)");
    expect(getComputedStyle(viewer.viewport).backgroundImage).toBe("none");
    const page = viewer.pagesElement.querySelector(".page");
    expect(getComputedStyle(page).backgroundImage).toBe("none");
    expect(getComputedStyle(page).backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("keeps pages borderless before and after rendering without changing canvas geometry", async () => {
    await open();
    const page = viewer.pagesElement.querySelector(".page");
    const expectNoBorder = () => {
      const style = getComputedStyle(page);
      expect(style.outlineStyle).toBe("none");
      for (const side of ["Top", "Right", "Bottom", "Left"])
        expect(style[`border${side}Width`]).toBe("0px");
    };
    expectNoBorder();
    await conditionPromise(() => page.querySelector("canvas"), "rendered PDF canvas", 10000);
    expectNoBorder();
    // PDF.js rounds the canvas width to a physical pixel.
    expect(
      Math.abs(page.getBoundingClientRect().width - viewer.pdfViewer.getPageView(0).viewport.width),
    ).toBeLessThan(1.1);
  });
});
