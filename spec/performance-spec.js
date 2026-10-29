const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Private inputs remain outside the package. The report records counts and
// timings only, never the document path, search query or extracted text.
if (process.env.PDF_VIEW_BENCH_FILE) {
  describe("PDF viewing performance", () => {
    it("measures real rendering and bounded search on the supplied document", async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("marker");
      await lumine.packages.activatePackage("scrollmap");
      const pack = await lumine.packages.activatePackage("pdf-view");
      lumine.config.set("pdf-view.autoRefresh", false);
      jasmine.attachToDOM(lumine.workspace.getElement());
      const rssBeforeBytes = process.memoryUsage().rss;
      const viewer = pack.mainModule.createViewer(process.env.PDF_VIEW_BENCH_FILE);
      viewer.element.style.cssText = "position:absolute;width:1200px;height:850px;top:0;left:0";
      const started = performance.now();
      await lumine.workspace.open(viewer);
      try {
        await viewer.whenReady();
        const loaded = performance.now();
        await conditionPromise(() => viewer.firstPaintAt, "large PDF first render", 60000);
        const initialBytes = viewer.document.bytesRead;
        const jumps = [];
        for (const page of [viewer.getPageCount(), Math.ceil(viewer.getPageCount() / 2), 1]) {
          const from = performance.now();
          viewer.goToPage(page);
          await conditionPromise(
            () => viewer.pdfViewer.getPageView(page - 1)?.renderingState === 3,
            "destination rendered",
            60000,
          );
          jumps.push({ page, ms: performance.now() - from });
        }
        const searchStarted = performance.now();
        const adapter = viewer.getSearchAdapter();
        await adapter.search({ findPattern: "a", caseSensitive: false, useRegex: false });
        const searchMs = performance.now() - searchStarted;
        const viewportBounds = viewer.viewport.getBoundingClientRect();
        const zoomStarted = performance.now();
        let zoomFrames = 0;
        let maxFrameGapMs = 0;
        let lastFrame;
        let frame;
        const sampleFrame = (time) => {
          if (lastFrame !== undefined) maxFrameGapMs = Math.max(maxFrameGapMs, time - lastFrame);
          lastFrame = time;
          zoomFrames++;
          frame = requestAnimationFrame(sampleFrame);
        };
        frame = requestAnimationFrame(sampleFrame);
        for (let tick = 0; tick < 8; tick++)
          viewer.viewport.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -10,
              clientX: viewportBounds.left + viewer.viewport.clientWidth * 0.65,
              clientY: viewportBounds.top + viewer.viewport.clientHeight * 0.4,
            }),
          );
        await viewer.zoomAnimation.promise;
        cancelAnimationFrame(frame);
        const zoomMs = performance.now() - zoomStarted;
        const report = {
          measuredOn: "2026-10-29",
          platform: process.platform,
          cpu: os.cpus()[0]?.model,
          electron: process.versions.electron,
          pdfjs: require("pdfjs-dist/package.json").version,
          fileBytes: viewer.document.size,
          pages: viewer.getPageCount(),
          loadMs: loaded - started,
          firstPaintMs: viewer.firstPaintAt - started,
          bytesReadAtFirstPaint: initialBytes,
          jumps,
          searchMs,
          zoomMs,
          zoomFrames,
          maxFrameGapMs,
          overviewMarkers:
            pack.mainModule.owner.scrollmaps.get(viewer)?.simplemap.items.length || 0,
          matches: adapter.getResultCount(),
          pending: adapter.isPending(),
          renderedCanvases: viewer.pagesElement.querySelectorAll("canvas").length,
          canvasPixels: [...viewer.pagesElement.querySelectorAll("canvas")].reduce(
            (sum, canvas) => sum + canvas.width * canvas.height,
            0,
          ),
          rssBeforeBytes,
          rssDeltaBytes: process.memoryUsage().rss - rssBeforeBytes,
          retainedSearchPages: adapter.cache.size,
          presentedSearchPages: adapter.presentedPages.size,
          retainedSearchHighlights: adapter.pageMatches.reduce(
            (sum, matches) => sum + (matches?.length || 0),
            0,
          ),
          rendererMemory: process.memoryUsage(),
        };
        const output =
          process.env.PDF_VIEW_BENCH_OUTPUT ||
          path.join(__dirname, "..", ".dev", "performance.json");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
        console.log("PDF benchmark", JSON.stringify(report));
        expect(report.pages).toBeGreaterThan(0);
        expect(report.pending).toBe(false);
        expect(report.renderedCanvases).toBeLessThan(20);
        expect(report.retainedSearchPages).toBeLessThanOrEqual(4);
        expect(report.presentedSearchPages).toBeLessThanOrEqual(6);
        expect(report.retainedSearchHighlights).toBeLessThanOrEqual(1206);
      } finally {
        const observation = viewer.fileObservation;
        await viewer.destroy();
        await observation.closed;
        await lumine.packages.deactivatePackage("pdf-view");
      }
    }, 180000);
  });
}
