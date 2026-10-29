const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF color inversion through a display provider", () => {
  let main, inversion, directory, viewer, copy;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-inversion-"));
    inversion = (await lumine.packages.activatePackage("invert-colors")).mainModule;
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    lumine.config.set("invert-colors.pdfViewState", true);
    jasmine.attachToDOM(lumine.workspace.getElement());
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 3 }));
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    await conditionPromise(
      () => viewer.pagesElement.querySelector(".page canvas"),
      "PDF color target",
      15000,
    );
  });

  afterEach(async () => {
    lumine.config.set("invert-colors.pdfViewState", false);
    const observations = [viewer?.fileObservation, copy?.fileObservation].filter(Boolean);
    await lumine.packages.deactivatePackage("pdf-view");
    await lumine.packages.deactivatePackage("invert-colors");
    await Promise.all(observations.map((observation) => observation.closed));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    viewer = copy = null;
  });

  it("accepts a newly opened PDF without a raw Viewer color API and filters only the document", async () => {
    expect(viewer.setColorInverted).toBeUndefined();
    expect(inversion.inversionTargets.size).toBe(1);
    expect(viewer.element.classList.contains("pdf-view-colors-inverted")).toBe(true);
    expect(getComputedStyle(viewer.pagesElement.querySelector(".page")).filter).toBe("invert(1)");
    expect(getComputedStyle(viewer.toolbar.group).filter).toBe("none");
    lumine.config.set("invert-colors.pdfViewState", false);
    await conditionPromise(
      () => getComputedStyle(viewer.pagesElement.querySelector(".page")).filter === "none",
      "normal PDF colors",
    );
    expect(getComputedStyle(viewer.pagesElement.querySelector(".page")).filter).toBe("none");
  });

  it("animates inversion in both directions while retaining the rendered page canvas", async () => {
    const page = viewer.pagesElement.querySelector(".page");
    const canvas = page.querySelector("canvas");
    const document = viewer.pdfDocument;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    expect(getComputedStyle(page).filter).toBe("invert(1)");
    for (const inverted of [false, true]) {
      lumine.config.set("invert-colors.pdfViewState", inverted);
      const transition = page
        .getAnimations()
        .find((animation) => animation.transitionProperty === "filter");
      if (reduced) {
        expect(transition).toBeUndefined();
      } else {
        expect(transition).toBeDefined();
        expect(transition.effect.getTiming().duration).toBe(200);
        expect(transition.effect.getTiming().easing).toBe("ease-in-out");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const value = Number(getComputedStyle(page).filter.match(/invert\(([\d.]+)\)/)?.[1]);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(1);
        await transition.finished;
      }
      expect(getComputedStyle(page).filter).toBe(inverted ? "invert(1)" : "none");
      expect(page.querySelector("canvas")).toBe(canvas);
      expect(viewer.pdfDocument).toBe(document);
      expect(getComputedStyle(viewer.toolbar.group).filter).toBe("none");
    }
  });

  it("keeps inversion across document reloads and tracks copied panes", async () => {
    const previous = viewer.pdfDocument;
    await viewer.reload();
    expect(viewer.pdfDocument).not.toBe(previous);
    expect(viewer.element.classList.contains("pdf-view-colors-inverted")).toBe(true);
    copy = (await lumine.workspace.copyPaneItem(viewer, { splitDirection: "right" })).item;
    copy.element.style.cssText = viewer.element.style.cssText;
    copy.layoutChanged();
    await copy.whenReady();
    expect(inversion.inversionTargets.size).toBe(2);
    expect(copy.element.classList.contains("pdf-view-colors-inverted")).toBe(true);
    await viewer.destroy();
    expect(inversion.inversionTargets.size).toBe(1);
  });

  it("resets display state on consumer withdrawal and reapplies it on reactivation", async () => {
    await lumine.packages.deactivatePackage("invert-colors");
    expect(viewer.element.classList.contains("pdf-view-colors-inverted")).toBe(false);
    inversion = (await lumine.packages.activatePackage("invert-colors")).mainModule;
    expect(inversion.inversionTargets.size).toBe(1);
    expect(viewer.element.classList.contains("pdf-view-colors-inverted")).toBe(true);
  });
});
