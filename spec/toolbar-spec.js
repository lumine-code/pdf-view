const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF viewing controls", () => {
  let main, viewer, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-controls-"));
    const pack = await lumine.packages.activatePackage("pdf-view");
    main = pack.mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    document.getSelection().removeAllRanges();
    if (viewer) {
      const observation = viewer.fileObservation;
      await viewer.destroy();
      await observation.closed;
      viewer = null;
    }
    await lumine.packages.deactivatePackage("pdf-view");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function open(pages = 8) {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages }));
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    await conditionPromise(
      () => viewer.pagesElement.querySelector(".page canvas"),
      "PDF canvas for control tests",
      15000,
    );
    return viewer;
  }

  function keymapEvent(target, key, modifiers = {}) {
    const event = lumine.keymaps.constructor.buildKeydownEvent(key, { target, ...modifiers });
    lumine.keymaps.handleKeyboardEvent(event);
    return event;
  }

  function inputKey(input, key) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
  }

  function openZoomMenu() {
    const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
    viewer.toolbar.scaleButton.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }

  it("leaves typing and clipboard shortcuts native in the page field, then commits or cancels", async () => {
    await open();
    viewer.setScale(1.5);
    const input = viewer.element.querySelector(".pdf-view-page-input");
    input.focus();
    const copy = spyOn(viewer, "copyText").and.callThrough();

    // Synthetic keydown cannot insert trusted browser text. Check that the
    // real keymap leaves insertion native, then supply the resulting input.
    expect(keymapEvent(input, "7").defaultPrevented).toBe(false);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.5, 3);
    input.value = "7";
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: "7" }),
    );
    const modifier = process.platform === "darwin" ? { cmd: true } : { ctrl: true };
    expect(keymapEvent(input, "c", modifier).defaultPrevented).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(viewer.getCurrentPage()).toBe(1);

    expect(inputKey(input, "Enter").defaultPrevented).toBe(true);
    expect(viewer.getCurrentPage()).toBe(7);
    expect(document.activeElement).toBe(viewer.viewport);

    input.focus();
    input.value = "8";
    expect(inputKey(input, "Escape").defaultPrevented).toBe(true);
    expect(input.value).toBe("7");
    expect(viewer.getCurrentPage()).toBe(7);
    expect(document.activeElement).toBe(viewer.viewport);
  });

  it("uses the image-editor keyboard conventions on the PDF surface", async () => {
    await open(3);
    viewer.focus();
    keymapEvent(viewer.viewport, "end");
    expect(viewer.getCurrentPage()).toBe(3);
    keymapEvent(viewer.viewport, "home");
    expect(viewer.getCurrentPage()).toBe(1);
    keymapEvent(viewer.viewport, "pagedown");
    expect(viewer.getCurrentPage()).toBe(2);
    keymapEvent(viewer.viewport, "pageup");
    expect(viewer.getCurrentPage()).toBe(1);
    keymapEvent(viewer.viewport, "0");
    await conditionPromise(
      () => Math.abs(viewer.pdfViewer.currentScale - 1) < 0.0001,
      "actual size zoom",
      10000,
    );
    expect(viewer.pdfViewer.currentScale).toBe(1);
    keymapEvent(viewer.viewport, "]");
    expect(viewer.pdfViewer.pagesRotation).toBe(90);
    keymapEvent(viewer.viewport, "[");
    expect(viewer.pdfViewer.pagesRotation).toBe(0);
  });

  it("uses a for automatic zoom and distinct theme backgrounds for adaptive modes", async () => {
    await open(3);
    const button = viewer.toolbar.scaleButton;
    button.style.setProperty("--ui-site-color-2", "rgb(20, 180, 50)");
    button.style.setProperty("--ui-site-color-3", "rgb(220, 120, 10)");
    viewer.element.style.setProperty("--button-background-color", "rgb(230, 230, 230)");
    viewer.setScale(1.25);
    const manual = getComputedStyle(button).backgroundColor;
    expect(button.classList.contains("selected")).toBe(false);
    keymapEvent(viewer.viewport, "a");
    await conditionPromise(() => viewer.zoomMode === "auto-width" && !viewer.zoomAnimation.active);
    expect(button.classList.contains("selected")).toBe(true);
    expect(button.dataset.zoomMode).toBe("auto-width");
    keymapEvent(viewer.viewport, "f");
    await conditionPromise(() => viewer.pdfViewer.currentScaleValue === "page-fit");
    const fit = getComputedStyle(button).backgroundColor;
    expect(button.dataset.zoomMode).toBe("page-fit");
    expect(button.classList.contains("selected")).toBe(false);
    keymapEvent(viewer.viewport, "w");
    await conditionPromise(() => viewer.pdfViewer.currentScaleValue === "page-width");
    const width = getComputedStyle(button).backgroundColor;
    expect(button.dataset.zoomMode).toBe("page-width");
    expect(fit).not.toBe(width);
    expect(fit).not.toBe(manual);
    expect(width).not.toBe(manual);
    keymapEvent(viewer.viewport, "0");
    await conditionPromise(() => viewer.pdfViewer.currentScaleValue === "1");
    expect(getComputedStyle(button).backgroundColor).toBe(manual);
    expect(button.classList.contains("selected")).toBe(false);
  });

  it("pans real page content with the hand tool and zooms only on modified wheel events", async () => {
    await open(3);
    viewer.setScale(2);
    viewer.viewport.scrollLeft = 150;
    viewer.viewport.scrollTop = 200;
    const startLeft = viewer.viewport.scrollLeft;
    const startTop = viewer.viewport.scrollTop;
    keymapEvent(viewer.viewport, "h");
    expect(viewer.getViewState().tool).toBe("hand");

    // Chromium grants capture only for trusted active pointers. Keep that
    // browser boundary stubbed while exercising real listeners and scrolling.
    spyOn(viewer.viewport, "setPointerCapture");
    spyOn(viewer.viewport, "hasPointerCapture").and.returnValue(true);
    const release = spyOn(viewer.viewport, "releasePointerCapture");
    viewer.viewport.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 7,
        clientX: 300,
        clientY: 300,
      }),
    );
    viewer.viewport.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 7,
        clientX: 260,
        clientY: 250,
      }),
    );
    expect(viewer.viewport.scrollLeft).toBe(startLeft + 40);
    expect(viewer.viewport.scrollTop).toBe(startTop + 50);
    expect(viewer.element.classList.contains("is-panning")).toBe(true);
    viewer.viewport.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
    expect(release).toHaveBeenCalledWith(7);
    expect(viewer.element.classList.contains("is-panning")).toBe(false);

    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    viewer.viewport.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(viewer.pdfViewer.currentScale).toBe(2);
    const modified = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
    });
    viewer.viewport.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(true);
    await viewer.zoomAnimation.promise;
    expect(viewer.pdfViewer.currentScale).toBeGreaterThan(2);
    keymapEvent(viewer.viewport, "s");
    expect(viewer.getViewState().tool).toBe("select");
  });

  it("zooms smoothly with the wheel over the scale button without scrolling or taking focus", async () => {
    await open(3);
    viewer.setScale(1);
    viewer.viewport.scrollTop = 200;
    const outside = document.createElement("input");
    jasmine.attachToDOM(outside);
    outside.focus();
    const bubbled = jasmine.createSpy("wheel outside the scale button");
    viewer.element.addEventListener("wheel", bubbled);
    const wheel = (deltaY, options = {}) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        ...options,
      });
      viewer.toolbar.scaleButton.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(outside);
      return viewer.zoomAnimation.promise;
    };

    wheel(-100);
    expect(viewer.zoomAnimation.active).toBe(true);
    const firstTarget = viewer.zoomAnimation.targetScale;
    expect(firstTarget).toBeGreaterThan(1);
    wheel(-100, { ctrlKey: true });
    expect(viewer.zoomAnimation.targetScale).toBeGreaterThan(firstTarget);
    wheel(100, { altKey: true });
    await wheel(100, { metaKey: true });
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1, 8);
    expect(viewer.viewport.scrollTop).toBeCloseTo(200, 0);
    expect(bubbled).not.toHaveBeenCalled();
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.element.removeEventListener("wheel", bubbled);
  });

  it("accepts fine, line and page wheel input on the scale button and releases its listener", async () => {
    await open(1);
    const button = viewer.toolbar.scaleButton;
    const wheel = (deltaY, deltaMode = 0) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode,
      });
      button.dispatchEvent(event);
      return event;
    };
    viewer.setScale(1);
    wheel(-0.5);
    const fineTarget = viewer.zoomAnimation.targetScale;
    expect(fineTarget).toBeGreaterThan(1);
    expect(fineTarget).toBeLessThan(1.01);
    wheel(0.5);
    await viewer.zoomAnimation.promise;
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1, 8);
    wheel(-16);
    const pixelTarget = viewer.zoomAnimation.targetScale;
    viewer.setScale(1);
    wheel(-1, WheelEvent.DOM_DELTA_LINE);
    expect(viewer.zoomAnimation.targetScale).toBeCloseTo(pixelTarget, 8);
    viewer.setScale(1);
    wheel(-16 / viewer.viewport.clientHeight, WheelEvent.DOM_DELTA_PAGE);
    expect(viewer.zoomAnimation.targetScale).toBeCloseTo(pixelTarget, 8);
    await viewer.zoomAnimation.promise;
    const scale = viewer.pdfViewer.currentScale;
    expect(wheel(0).defaultPrevented).toBe(false);
    expect(viewer.pdfViewer.currentScale).toBe(scale);
    viewer.setScale(10);
    expect(wheel(-100).defaultPrevented).toBe(true);
    await viewer.zoomAnimation.promise;
    expect(viewer.pdfViewer.currentScale).toBe(10);

    await viewer.destroy();
    const zoom = spyOn(viewer, "zoomBy");
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(zoom).not.toHaveBeenCalled();
  });

  it("navigates with the wheel anywhere on the page counter while preserving focus and page bounds", async () => {
    await open(3);
    viewer.setScale(1);
    const { pageInput, pageCount } = viewer.toolbar;
    const field = pageInput.parentElement;
    const bubbled = jasmine.createSpy("wheel outside the page counter");
    viewer.element.addEventListener("wheel", bubbled);
    const wheel = (target, deltaY) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(pageInput.value).toBe(String(viewer.getCurrentPage()));
    };
    viewer.focus();
    wheel(pageCount, 100);
    expect(viewer.getCurrentPage()).toBe(2);
    expect(document.activeElement).toBe(viewer.viewport);
    pageInput.focus();
    wheel(pageInput, 100);
    expect(viewer.getCurrentPage()).toBe(3);
    expect(document.activeElement).toBe(pageInput);
    wheel(field, 100);
    expect(viewer.getCurrentPage()).toBe(3);
    wheel(pageInput, -0.5);
    expect(viewer.getCurrentPage()).toBe(2);
    wheel(pageCount, -100);
    wheel(field, -100);
    expect(viewer.getCurrentPage()).toBe(1);
    expect(viewer.pdfViewer.currentScale).toBe(1);
    expect(bubbled).not.toHaveBeenCalled();
    viewer.element.removeEventListener("wheel", bubbled);

    await viewer.destroy();
    const navigate = spyOn(viewer, "goToPage");
    const after = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    pageInput.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("merges PDF actions with the inherited split and close context actions", async () => {
    await open(1);
    const page = viewer.pagesElement.querySelector(".page");
    const rows = lumine.contextMenu.templateForElement(page);
    const commands = rows.map((row) => row.command).filter(Boolean);
    expect(rows.find((row) => row.command === "pdf-view:copy").label).toBe("Copy Text");
    expect(commands).toContain("pdf-view:synctex");
    expect(commands).toContain("pane:split-right-and-copy-active-item");
    expect(commands.filter((command) => command === "pane:close").length).toBe(1);
    expect(commands.at(-1)).toBe("pane:close");
    expect(rows[0].type).not.toBe("separator");
    expect(rows.at(-1).type).not.toBe("separator");
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].type === "separator" && rows[index - 1].type === "separator").toBe(false);
    }
  });

  it("uses host theme variables for a compact floating button group", async () => {
    await open(1);
    const group = viewer.element.querySelector(".pdf-view-controls-group.btn-group");
    viewer.element.style.setProperty("--tool-panel-background-color", "rgb(10, 20, 30)");
    viewer.element.style.setProperty("--text-color", "rgb(20, 40, 60)");
    viewer.element.style.setProperty("--ui-border-radius", "6px");
    const firstBackground = getComputedStyle(group).backgroundColor;
    expect(firstBackground).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(group).opacity).toBe("1");
    expect(getComputedStyle(viewer.viewport).position).toBe("absolute");
    expect(getComputedStyle(viewer.toolbar.element).pointerEvents).toBe("none");
    expect(getComputedStyle(group).pointerEvents).toBe("auto");
    expect(getComputedStyle(group).borderTopLeftRadius).toBe("0px");
    expect(getComputedStyle(group).borderBottomLeftRadius).toBe("6px");
    expect(getComputedStyle(group).color).toBe("rgb(20, 40, 60)");
    viewer.element.style.setProperty("--tool-panel-background-color", "rgb(80, 90, 100)");
    expect(getComputedStyle(group).backgroundColor).toBe("rgb(80, 90, 100)");
    expect(group.querySelectorAll("button.btn").length).toBeGreaterThan(5);
    expect(viewer.element.querySelector("input[type=search], .pdf-view-outline")).toBeNull();
    const reference = document.createElement("div");
    reference.className = "btn-group";
    reference.style.cssText = "position:absolute;visibility:hidden";
    for (let index = 0; index < 3; index++) {
      const button = document.createElement("button");
      button.className = "btn";
      button.textContent = "+";
      reference.append(button);
    }
    viewer.element.append(reference);
    try {
      const native = getComputedStyle(reference.children[1]);
      const toolbar = getComputedStyle(viewer.toolbar.buttons.get("zoom-in"));
      for (const property of [
        "height",
        "lineHeight",
        "paddingLeft",
        "paddingRight",
        "fontSize",
        "backgroundColor",
      ])
        expect(toolbar[property]).toBe(native[property]);
      expect(toolbar.borderTopWidth).toBe("0px");
      expect(toolbar.borderBottomWidth).toBe(native.borderBottomWidth);
      reference.children[0].disabled = true;
      expect(getComputedStyle(viewer.toolbar.buttons.get("first-page")).opacity).toBe(
        getComputedStyle(reference.children[0]).opacity,
      );
    } finally {
      reference.remove();
    }
  });

  it("uses the native button font for the current page, total and zoom label", async () => {
    await open(3);
    const elements = [
      viewer.toolbar.pageInput.closest(".btn"),
      viewer.toolbar.pageInput,
      viewer.toolbar.pageCount,
      viewer.toolbar.scaleButton,
    ];
    viewer.element.style.fontFamily = "var(--ui-font-family)";
    for (const [family, size, height] of [
      ["monospace", "14px", "30px"],
      ["serif", "17px", "38px"],
    ]) {
      viewer.element.style.setProperty("--ui-font-family", family);
      viewer.element.style.setProperty("--ui-font-size", size);
      viewer.element.style.setProperty("--ui-unit", size);
      viewer.element.style.setProperty("--ui-row-height", height);
      viewer.element.style.setProperty("--ui-control-height", height);
      const native = getComputedStyle(viewer.toolbar.buttons.get("zoom-in"));
      expect(native.fontFamily).toBe(family);
      expect(native.fontSize).toBe(size);
      expect(native.fontVariantNumeric).toBe("tabular-nums");
      for (const element of elements) {
        const actual = getComputedStyle(element);
        for (const property of [
          "fontFamily",
          "fontSize",
          "fontWeight",
          "lineHeight",
          "fontVariantNumeric",
        ])
          expect(actual[property])
            .withContext(`${element.className}: ${property}`)
            .toBe(native[property]);
      }
    }
  });

  it("overlays a compact toolbar without reserving a row above the PDF", async () => {
    await open(1);
    await viewer.executeCommand("fit-to-view");
    for (let frame = 0; frame < 3; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const page = viewer.pagesElement.querySelector(".page").getBoundingClientRect();
    const viewport = viewer.viewport.getBoundingClientRect();
    const controls = viewer.toolbar.element.getBoundingClientRect();
    const item = viewer.element.getBoundingClientRect();
    const group = viewer.toolbar.group.getBoundingClientRect();
    expect(viewport.top).toBeCloseTo(item.top, 1);
    expect(viewport.height).toBeCloseTo(item.height, 1);
    expect(controls.top).toBeCloseTo(viewport.top, 1);
    expect(group.width).toBeLessThan(viewport.width);
    expect(page.left).toBeGreaterThanOrEqual(viewport.left - 1);
    expect(page.right).toBeLessThanOrEqual(viewport.right + 1);
    expect(page.top).toBeGreaterThanOrEqual(viewport.top - 1);
    expect(page.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
    expect(page.top).toBeLessThan(controls.bottom);
  });

  it("orders only the requested page and zoom controls", async () => {
    await open(3);
    const order = [...viewer.toolbar.group.children].map((element) =>
      element.classList.contains("pdf-view-page-field") ? "page/pages" : element.dataset.action,
    );
    expect(order).toEqual([
      "first-page",
      "previous-page",
      "zoom-out",
      "page/pages",
      "automatic-zoom",
      "zoom-in",
      "next-page",
      "last-page",
    ]);
    expect(
      viewer.toolbar.group.querySelector(".pdf-view-zoom-menu-button, .pdf-view-zoom-chevron"),
    ).toBeNull();
    expect(getComputedStyle(viewer.toolbar.buttons.get("first-page")).cursor).toBe("default");
  });

  it("shares one separator with the breadcrumb bar above the floating controls", async () => {
    const wasActive = Boolean(lumine.packages.getActivePackage("breadcrumbs"));
    await lumine.packages.activatePackage("breadcrumbs");
    try {
      await open(3);
      const pane = lumine.workspace.paneForItem(viewer).element;
      await conditionPromise(
        () => pane.querySelector(".breadcrumbs:not([hidden])"),
        "PDF breadcrumbs",
        10000,
      );
      const breadcrumbs = pane.querySelector(".breadcrumbs");
      expect(getComputedStyle(breadcrumbs).borderBottomWidth).toBe("1px");
      for (const button of viewer.toolbar.group.querySelectorAll(".btn")) {
        expect(getComputedStyle(button).borderTopWidth).toBe("0px");
      }
    } finally {
      if (!wasActive) await lumine.packages.deactivatePackage("breadcrumbs");
    }
  });

  it("updates the zoom number immediately without animating the label", async () => {
    await open(3);
    viewer.setScale(1.23456);
    expect(viewer.toolbar.scaleButton.textContent).toBe("123%");
    expect(viewer.pdfViewer.currentScale).toBe(1.23456);
    viewer.setScale(1);
    viewer.toolbar.buttons.get("zoom-in").click();
    expect(viewer.toolbar.scaleButton.textContent).toBe("110%");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(viewer.toolbar.scaleButton.textContent).toBe("110%");
    await viewer.zoomAnimation.promise;
    expect(viewer.toolbar.scaleButton.textContent).toBe("110%");
    viewer.toolbar.buttons.get("zoom-out").click();
    expect(viewer.toolbar.scaleButton.textContent).toBe("100%");
    await viewer.zoomAnimation.promise;
  });

  it("keeps ordinary zoom relative and steps modifier shortcuts through the menu levels", async () => {
    await open(3);
    const run = spyOn(main, "run").and.callThrough();
    const modifier = process.platform === "darwin" ? { cmd: true } : { ctrl: true };
    viewer.setScale(1);
    keymapEvent(viewer.viewport, "+");
    expect(viewer.zoomAnimation.targetScale).toBeCloseTo(1.1, 8);
    keymapEvent(viewer.viewport, "+");
    expect(viewer.zoomAnimation.targetScale).toBeCloseTo(1.21, 8);
    await run.calls.mostRecent().returnValue;

    viewer.setScale(1);
    keymapEvent(viewer.viewport, "+", modifier);
    expect(viewer.zoomAnimation.targetScale).toBe(1.25);
    keymapEvent(viewer.viewport, "+", modifier);
    expect(viewer.zoomAnimation.targetScale).toBe(1.5);
    keymapEvent(viewer.viewport, "-", modifier);
    expect(viewer.zoomAnimation.targetScale).toBe(1.25);
    expect(viewer.toolbar.scaleButton.textContent).toBe("125%");
    await run.calls.mostRecent().returnValue;

    viewer.setScale(0.73);
    keymapEvent(viewer.viewport, "+", modifier);
    await run.calls.mostRecent().returnValue;
    expect(viewer.pdfViewer.currentScale).toBe(0.75);
    viewer.setScale(0.73);
    keymapEvent(viewer.viewport, "-", modifier);
    await run.calls.mostRecent().returnValue;
    expect(viewer.pdfViewer.currentScale).toBe(0.5);
    keymapEvent(viewer.viewport, "-", modifier);
    expect(viewer.pdfViewer.currentScale).toBe(0.5);
    viewer.setScale(4);
    keymapEvent(viewer.viewport, "+", modifier);
    expect(viewer.pdfViewer.currentScale).toBe(4);
  });

  it("captures right-clicks on other controls without opening the document menu", async () => {
    await open(3);
    viewer.setScale(1);
    const bubbled = jasmine.createSpy("document context menu");
    viewer.element.addEventListener("contextmenu", bubbled);
    for (const [action, button] of viewer.toolbar.buttons) {
      if (action === "automatic-zoom") continue;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(bubbled).not.toHaveBeenCalled();
    expect(viewer.pdfViewer.currentScale).toBe(1);
    expect(viewer.getCurrentPage()).toBe(1);
    expect(viewer.toolbar.zoomMenu).toBeUndefined();
    viewer.element.removeEventListener("contextmenu", bubbled);
    openZoomMenu();
    expect(viewer.toolbar.zoomMenu).not.toBeNull();
  });

  it("returns pointer focus to the document while preserving keyboard button focus", async () => {
    await open(3);
    const button = viewer.toolbar.buttons.get("zoom-in");
    viewer.focus();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.activeElement).toBe(viewer.viewport);
    button.focus();
    button.click();
    expect(document.activeElement).toBe(button);
    await viewer.zoomAnimation.promise;
  });

  for (const key of ["a", "f", "w", "0", "+", "-"]) {
    it(`keeps document focus when ${key} rebuilds a focused PDF text layer`, async () => {
      await open(3);
      const run = spyOn(main, "run").and.callThrough();
      await conditionPromise(
        () => viewer.pagesElement.querySelector(".textLayer span"),
        "focusable PDF text",
        1500,
      );
      const layer = viewer.pagesElement.querySelector(".textLayer");
      layer.focus();
      expect(document.activeElement).toBe(layer);
      keymapEvent(layer, key);
      expect(document.activeElement).toBe(viewer.viewport);
      await run.calls.mostRecent().returnValue;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(viewer.viewport);
      expect(lumine.workspace.getActivePaneItem()).toBe(viewer);
      const pending = viewer.setScale(1.5, { smooth: true });
      const other = document.createElement("input");
      jasmine.attachToDOM(other);
      other.focus();
      await pending;
      expect(document.activeElement).toBe(other);
    });
  }

  it("uses the shared menu to choose a preset and restores PDF focus", async () => {
    await open(3);
    viewer.setScale(1.25);
    openZoomMenu();
    expect(viewer.pdfViewer.currentScale).toBe(1.25);
    expect(viewer.toolbar.scaleButton.getAttribute("aria-expanded")).toBe("true");
    const menu = viewer.toolbar.zoomMenu;
    expect(menu.element.classList.contains("pdf-view-zoom-menu")).toBe(true);
    const rows = [...menu.element.querySelectorAll('[role="menuitemradio"]')];
    expect(rows.map((row) => row.querySelector(".menu-item-name").textContent.trim())).toEqual([
      "Automatic Zoom",
      "Fit to View",
      "Fit Width",
      "50%",
      "75%",
      "100%",
      "125%",
      "150%",
      "200%",
      "300%",
      "400%",
    ]);
    expect(rows.find((row) => row.textContent.trim() === "125%").getAttribute("aria-checked")).toBe(
      "true",
    );
    rows.find((row) => row.textContent.trim() === "150%").click();
    await flushMicrotasks();
    await conditionPromise(
      () => Math.abs(viewer.pdfViewer.currentScale - 1.5) < 0.0001,
      "preset zoom animation",
      10000,
    );
    expect(viewer.pdfViewer.currentScale).toBe(1.5);
    expect(viewer.getViewState().zoomMode).not.toBe("auto-width");
    expect(viewer.toolbar.zoomMenu).toBeNull();
    expect(viewer.toolbar.scaleButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(viewer.viewport);
    openZoomMenu();
    const hundred = [
      ...viewer.toolbar.zoomMenu.element.querySelectorAll('[role="menuitemradio"]'),
    ].find((row) => row.querySelector(".menu-item-name").textContent.trim() === "100%");
    expect(hundred.querySelector(".menu-item-keystroke").textContent).toBe("0");
    hundred.click();
    await flushMicrotasks();
    await conditionPromise(
      () => viewer.pdfViewer.currentScale === 1 && !viewer.zoomAnimation.active,
    );
    openZoomMenu();
    const checked = [...viewer.toolbar.zoomMenu.element.querySelectorAll('[aria-checked="true"]')];
    expect(checked.map((row) => row.querySelector(".menu-item-name").textContent.trim())).toEqual([
      "100%",
    ]);
    const pendingMenu = viewer.toolbar.zoomMenu;
    await viewer.destroy();
    expect(pendingMenu.closed).toBe(true);
  });
});
