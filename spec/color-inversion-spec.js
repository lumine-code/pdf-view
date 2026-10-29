const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF color inversion provider", () => {
  let viewer, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-inversion-provider-"));
    await lumine.packages.activatePackage("invert-colors");
    const pack = await lumine.packages.activatePackage("pdf-view");
    lumine.config.set("pdf-view.autoRefresh", false);
    lumine.config.set("invert-colors.pdfViewState", true);
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf());
    viewer = pack.mainModule.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    jasmine.attachToDOM(viewer.element);
    await viewer.whenReady();
    await globalThis.conditionPromise(
      () => viewer.frame.contentDocument.querySelector(".page canvas"),
      "PDF color provider",
      15000,
    );
  });

  afterEach(async () => {
    lumine.config.set("invert-colors.pdfViewState", false);
    const observation = viewer?.file;
    viewer?.destroy();
    await observation?.closed;
    await lumine.packages.deactivatePackage("pdf-view");
    await lumine.packages.deactivatePackage("invert-colors");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    viewer = null;
  });

  it("exposes its iframe presentation through the generic inversion target contract", async () => {
    expect(
      viewer.frame.contentDocument.documentElement.classList.contains("pdf-view-colors-inverted"),
    ).toBe(true);
    await lumine.packages.deactivatePackage("invert-colors");
    await globalThis.conditionPromise(
      () =>
        !viewer.frame.contentDocument.documentElement.classList.contains(
          "pdf-view-colors-inverted",
        ),
      "inversion reset",
      10000,
    );
    await lumine.packages.activatePackage("invert-colors");
    await globalThis.conditionPromise(
      () =>
        viewer.frame.contentDocument.documentElement.classList.contains("pdf-view-colors-inverted"),
      "inversion restored",
      10000,
    );
  });
});
