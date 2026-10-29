const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF navigation-panel service integration", () => {
  let directory, viewer, navigation;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-native-navigation-"));
    await lumine.packages.deactivatePackage("navigation-panel");
    navigation = (await lumine.packages.activatePackage("navigation-panel")).mainModule;
    await lumine.packages.activatePackage("pdf-view");
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("navigation-panel");
    const observation = viewer?.fileObservation;
    await lumine.packages.deactivatePackage("pdf-view");
    await observation?.closed;
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("Unsafe PDF navigation fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    viewer = null;
  });

  it("shows real bookmarks via the registered adapter and opens the chosen named destination", async () => {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(
      file,
      createPdf({
        pages: 3,
        outline: [
          { title: "Introduction", page: 0, dest: "intro" },
          { title: "Methods", page: 1, dest: "methods" },
          { title: "Results", page: 2, dest: "results" },
        ],
      }),
    );
    const main = lumine.packages.getActivePackage("pdf-view").mainModule;
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();

    // Test orchestration may select named implementations. Production code
    // publishes only navigation.adapter and never opens or looks up this panel.
    lumine.commands.dispatch(viewer.viewport, "navigation-panel:open");
    await conditionPromise(
      () => navigation.navigationTree?.element.querySelectorAll(".navigation-text").length === 3,
      "PDF bookmarks in navigation-panel",
      15000,
    );
    const tree = navigation.navigationTree;
    const service = navigation.provideNavigationHeaders();
    expect(service.getEditor()).toBe(viewer);
    expect(service.getFlattenHeaders().map((header) => header.text)).toEqual([
      "Introduction",
      "Methods",
      "Results",
    ]);
    expect(service.getFlattenHeaders()[2].dest).toBe("results");
    expect(
      [...tree.element.querySelectorAll(".navigation-text")].map((element) =>
        element.textContent.trim(),
      ),
    ).toEqual(["Introduction", "Methods", "Results"]);
    expect(viewer.element.querySelector(".navigation-panel")).toBeNull();

    const navigate = spyOn(viewer.linkService, "goToDestination").and.callThrough();
    tree.element.querySelectorAll(".navigation-text")[2].click();
    await conditionPromise(
      () => viewer.getCurrentPage() === 3,
      "navigation-panel PDF destination",
      10000,
    );
    expect(navigate).toHaveBeenCalledWith("results");
    await conditionPromise(
      () =>
        service.getFlattenHeaders().find((header) => header.text === "Results")?.currentCount === 1,
      "navigation-panel active PDF bookmark",
      10000,
    );
  }, 30000);

  it("smoothly follows a long PDF outline without rebuilding its rows on scroll", async () => {
    const file = path.join(directory, "long-outline.pdf");
    fs.writeFileSync(
      file,
      createPdf({
        pages: 64,
        outline: Array.from({ length: 64 }, (_, index) => ({
          title: `Section ${index + 1}`,
          page: index,
        })),
      }),
    );
    const main = lumine.packages.getActivePackage("pdf-view").mainModule;
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    lumine.commands.dispatch(viewer.viewport, "navigation-panel:open");
    const service = navigation.provideNavigationHeaders();
    await conditionPromise(
      () =>
        service.getFlattenHeaders().length === 64 &&
        service.getFlattenHeaders().every((header) => header.badge !== null),
      "resolved long PDF outline",
      15000,
    );
    const tree = navigation.navigationTree;
    tree.element.style.height = "240px";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await conditionPromise(
      () => tree.element.querySelectorAll(".navigation-text").length === 64,
      "long outline rows",
      10000,
    );
    const scroller = tree.refs.navigationScroller;
    scroller.scrollTop = 0;
    tree.cancelScrollAnimation();
    const initialRows = [...tree.element.querySelectorAll(".navigation-block")];
    const animate = spyOn(tree, "animateScrollTo").and.callThrough();
    const update = spyOn(tree, "update").and.callThrough();
    const build = spyOn(navigation.adapterManager, "buildHeaders").and.callThrough();
    const media = window.matchMedia.bind(window);
    spyOn(window, "matchMedia").and.callFake((query) =>
      query === "(prefers-reduced-motion: reduce)" ? { matches: false } : media(query),
    );
    const samples = [];
    let frame;
    let collecting = true;
    const sample = () => {
      samples.push(scroller.scrollTop);
      if (collecting) frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    try {
      viewer.goToPage(50);
      await conditionPromise(
        () => animate.calls.count() > 0 && tree.scrollAnimationID === null,
        "smooth outline tracking",
        5000,
      );
      const finalPosition = scroller.scrollTop;
      expect(finalPosition).toBeGreaterThan(0);
      expect(samples.some((value) => value > 0 && value < finalPosition - 1)).toBe(true);
      expect(update).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect([...tree.element.querySelectorAll(".navigation-block")]).toEqual(initialRows);
    } finally {
      collecting = false;
      cancelAnimationFrame(frame);
    }
  }, 30000);
});
