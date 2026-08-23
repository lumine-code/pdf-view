const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
// The keymap/menu files are JSON that may carry // comments (Lumine's loader
// parses them with a JSONC parser). Strip whole-line comments before JSON.parse
// so the tests can validate their structure without pulling in a JSONC parser.
const parseJsonc = (rel) => JSON.parse(read(rel).replace(/^\s*\/\/.*$/gm, ""));

// Guards for the pdf-viewer -> pdf-view rebrand and the CSON -> JSON / Less -> CSS
// modernization. The package's own identifiers (name, commands, config, the
// pdf-view provided service, deserializer, CSS classes) are renamed; the shared
// cross-package service contracts (navigation.adapter, scrollmap.widget) are preserved.
describe("pdf-view package assets", () => {
  it("ships keymaps and menus as JSON (comments allowed), not CSON or JSONC", () => {
    expect(exists("keymaps/main.json")).toBe(true);
    expect(exists("menus/main.json")).toBe(true);
    expect(exists("keymaps/pdf-viewer.cson")).toBe(false);
    expect(exists("menus/pdf-viewer.cson")).toBe(false);
    expect(exists("keymaps/main.jsonc")).toBe(false);
    expect(exists("menus/main.jsonc")).toBe(false);
  });

  it("parses the keymap under the renamed selector and binds pdf-view commands", () => {
    const keymap = parseJsonc("keymaps/main.json");
    expect(keymap[".pdf-view"]).toBeDefined();
    expect(keymap[".pdf-viewer"]).toBeUndefined();
    expect(keymap[".pdf-view"]["f5"]).toBe("pdf-view:refresh");
    expect(read("keymaps/main.json")).not.toContain("pdf-viewer:");
  });

  it("binds the bare zoom and fit keys PDF.js leaves free", () => {
    // PDF.js zooms on Ctrl alone and binds no bare letter for either fit
    // preset, so these keys reach nothing inside the iframe unless the keymap
    // claims them. `.image-editor` and `.graviss` spell the same four zoom keys.
    const bindings = parseJsonc("keymaps/main.json")[".pdf-view"];
    expect(bindings["f"]).toBe("pdf-view:page-fit");
    expect(bindings["w"]).toBe("pdf-view:page-width");
    expect(bindings["="]).toBe("pdf-view:zoom-in");
    expect(bindings["+"]).toBe("pdf-view:zoom-in");
    expect(bindings["-"]).toBe("pdf-view:zoom-out");
    expect(bindings["_"]).toBe("pdf-view:zoom-out");
  });

  it("shadows every core binding that would otherwise fire inside a PDF", () => {
    // A command event counts as handled even with no listener, so a core
    // binding that reaches `.pdf-view` both acts on the window and is
    // preventDefault'd — which stops the redispatch bridge from ever handing
    // the key back to PDF.js. Core binds all four zoom keys and backspace at
    // `body`; shadowing three of the four left Ctrl+Shift+Minus resizing the
    // window font from inside a PDF, and backspace doing nothing at all.
    const bindings = parseJsonc("keymaps/main.json")[".pdf-view"];
    for (const keystroke of ["cmdorctrl-=", "cmdorctrl-+", "cmdorctrl--", "cmdorctrl-_"]) {
      expect(bindings[keystroke]).toMatch(/^pdf-view:zoom-(in|out)$/);
    }
    expect(bindings["backspace"]).toBe("pdf-view:page-up");
    expect(bindings["shift-backspace"]).toBe("pdf-view:page-up");
  });

  it("parses the menu, uses `command`, and carries no pdf-viewer commands", () => {
    const menu = parseJsonc("menus/main.json");
    expect(Array.isArray(menu.menu)).toBe(true);
    const flat = JSON.stringify(menu);
    expect(flat).not.toContain('"commands"');
    expect(read("menus/main.json")).not.toContain("pdf-viewer:");
    expect(flat).toContain("pdf-view:refresh");
  });

  it("backs every forwarded command with a case in the iframe script", () => {
    // The command name is registered in lib/main.js and handled in
    // vendors/custom/viewer.js, two files that nothing else ties together — a
    // forwarded name with no matching `case` is a menu item that silently does
    // nothing. `own` commands are handled by the Viewer itself, not forwarded.
    const own = ["compile", "open-tex", "refresh", "toggle-refreshing"];
    const commands = Object.keys(require("../lib/main").viewerCommands());
    const custom = read("vendors/custom/viewer.js");

    for (const command of commands) {
      const name = command.replace(/^pdf-view:/, "");
      if (own.includes(name)) continue;
      expect(custom).toContain(`case "${name}":`);
    }
    // The zoom presets name the same values as the `defaultZoom` setting.
    for (const preset of ["page-width", "page-fit", "page-actual"]) {
      expect(commands).toContain(`pdf-view:${preset}`);
      expect(JSON.parse(read("package.json")).configSchema.defaultZoom.enum).toContain(preset);
    }
  });

  it("names only registered commands in the menu and the keymap", () => {
    const registered = new Set([
      "pdf-view:reload-all",
      ...Object.keys(require("../lib/main").viewerCommands()),
    ]);
    const named = [];
    const walk = (items) => {
      for (const item of items) {
        if (item.command) named.push(item.command);
        if (item.submenu) walk(item.submenu);
      }
    };
    walk(parseJsonc("menus/main.json").menu);
    named.push(...Object.values(parseJsonc("keymaps/main.json")[".pdf-view"]));

    expect(named.length).toBeGreaterThan(0);
    for (const command of named) {
      expect(registered.has(command)).toBe(true);
    }
  });

  it("keeps the config JSON free of trailing commas", () => {
    // House style allows // comments but forbids trailing commas.
    expect(read("keymaps/main.json")).not.toMatch(/,\s*[}\]]/);
    expect(read("menus/main.json")).not.toMatch(/,\s*[}\]]/);
  });

  it("ships CSS stylesheets built on custom properties, not Less", () => {
    expect(exists("styles/main.css")).toBe(true);
    expect(exists("styles/pdf-viewer.less")).toBe(false);
    const css = read("styles/main.css");
    expect(css).toContain("var(--");
    expect(css).not.toContain('@import "ui-variables"');
    expect(css).toContain(".pdf-view-scrollmap");
  });

  it("ships a static, committed iframe stylesheet instead of runtime-compiled Less", () => {
    expect(exists("vendors/custom/viewer.css")).toBe(true);
    expect(exists("vendors/custom/viewer.less")).toBe(false);
    const css = read("vendors/custom/viewer.css");
    expect(css).toContain("var(--text-color)");
    expect(css).not.toContain("@import");
    expect(css).toContain(".pdf-view-colors-inverted");
  });

  it("fills page-width and mirrors the host scrollbar width into the iframe", () => {
    const pdfViewer = read("vendors/pdfjs-dist/web/viewer.mjs");
    const constructor = pdfViewer.match(
      /const pdfViewer = this\.pdfViewer = new PDFViewer\(\{[\s\S]*?\n {4}\}\);/,
    );
    expect(constructor).not.toBeNull();
    expect(constructor[0]).toContain("removePageBorders: true");

    // Preserve the vendor change across future PDF.js updates.
    expect(read("scripts/update.js")).toContain("enabled borderless full-width pages");

    const custom = read("vendors/custom/viewer.js");
    const css = read("vendors/custom/viewer.css");
    expect(custom).toContain("probe.offsetWidth - probe.clientWidth");
    expect(custom).toContain('"--pdf-scrollbar-width"');
    expect(css).toContain("width: var(--pdf-scrollbar-width, 10px)");
    expect(css).toContain("height: var(--pdf-scrollbar-width, 10px)");
  });

  it("renames the package to match its directory and keeps shared service contracts", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("pdf-view");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toContain("lumine-code/pdf-view");
    // The package's own service is renamed with it...
    expect(pkg.providedServices["pdf-view"]).toBeDefined();
    expect(pkg.providedServices["pdf-viewer"]).toBeUndefined();
    expect(pkg.deserializers["pdf-view"]).toBeDefined();
    expect(pkg.deserializers["pdf-viewer"]).toBeUndefined();
    // ...but the shared cross-package contracts are kept verbatim.
    expect(pkg.providedServices["navigation.adapter"]).toBeDefined();
    expect(pkg.consumedServices["scrollmap.widget"]).toBeDefined();
    expect(pkg.consumedServices["latex-tools"]).toBeDefined();
    expect(pkg.consumedServices["typst-tools"]).toBeDefined();
  });

  it("drops the removed File API and runtime Less compilation from the sources", () => {
    const viewer = read("lib/viewer.js");
    expect(viewer).toContain('watchFile } = require("lumine")');
    expect(viewer).not.toMatch(/\bnew File\(/);
    const main = read("lib/main.js");
    expect(main).not.toContain("loadLessStylesheet");
    expect(main).not.toContain("prepareCSS");
  });

  it("extracts the pure outline helpers into their own testable module", () => {
    expect(exists("lib/outline.js")).toBe(true);
    const main = read("lib/main.js");
    expect(main).toContain('require("./outline")');
    const outline = require("../lib/outline");
    expect(typeof outline.enrichOutline).toBe("function");
    expect(typeof outline.markOutlineState).toBe("function");
  });

  it("reports the visible outline entries after the scroll, never from the event", () => {
    // PDFViewer dispatches "pagechanging" from #scrollIntoView and, for a
    // destination that carries a zoom, "updateviewarea" from the scale change —
    // both before it assigns container.scrollTop. Reading the viewport in those
    // handlers reports the region being left, which made the navigation panel
    // scroll its list back to the entry the user had just navigated away from.
    const custom = read("vendors/custom/viewer.js");
    expect(custom).toContain('eventBus.on("pagechanging", scheduleCurrentDest)');
    expect(custom).toContain('eventBus.on("updateviewarea", scheduleCurrentDest)');
    expect(custom).toMatch(/function scheduleCurrentDest\(\)[\s\S]*setTimeout/);
  });

  it("renews its subscriptions in setFile so the watchFile watcher is not leaked", () => {
    // A CompositeDisposable stays disposed once disposed, so `add()` after
    // dispose is a no-op. watchFile owns a native watcher that must be disposed;
    // setFile must therefore install a fresh CompositeDisposable, not re-add to
    // the disposed one (which would silently drop the watcher's disposal).
    const viewer = read("lib/viewer.js");
    expect(viewer).toMatch(/this\.subscriptions\s*=\s*new CompositeDisposable\(\)/);
    expect(viewer).toContain("file.dispose()");
  });
});
