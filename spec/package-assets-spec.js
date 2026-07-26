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
    expect(exists("keymaps/pdf-view.json")).toBe(true);
    expect(exists("menus/pdf-view.json")).toBe(true);
    expect(exists("keymaps/pdf-viewer.cson")).toBe(false);
    expect(exists("menus/pdf-viewer.cson")).toBe(false);
    expect(exists("keymaps/pdf-view.jsonc")).toBe(false);
    expect(exists("menus/pdf-view.jsonc")).toBe(false);
  });

  it("parses the keymap under the renamed selector and binds pdf-view commands", () => {
    const keymap = parseJsonc("keymaps/pdf-view.json");
    expect(keymap[".pdf-view"]).toBeDefined();
    expect(keymap[".pdf-viewer"]).toBeUndefined();
    expect(keymap[".pdf-view"]["f5"]).toBe("pdf-view:refresh");
    expect(read("keymaps/pdf-view.json")).not.toContain("pdf-viewer:");
  });

  it("parses the menu, uses `command`, and carries no pdf-viewer commands", () => {
    const menu = parseJsonc("menus/pdf-view.json");
    expect(Array.isArray(menu.menu)).toBe(true);
    const flat = JSON.stringify(menu);
    expect(flat).not.toContain('"commands"');
    expect(read("menus/pdf-view.json")).not.toContain("pdf-viewer:");
    expect(flat).toContain("pdf-view:refresh");
  });

  it("keeps the config JSON free of trailing commas", () => {
    // House style allows // comments but forbids trailing commas.
    expect(read("keymaps/pdf-view.json")).not.toMatch(/,\s*[}\]]/);
    expect(read("menus/pdf-view.json")).not.toMatch(/,\s*[}\]]/);
  });

  it("ships CSS stylesheets built on custom properties, not Less", () => {
    expect(exists("styles/pdf-view.css")).toBe(true);
    expect(exists("styles/pdf-viewer.less")).toBe(false);
    const css = read("styles/pdf-view.css");
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
    expect(viewer).toContain('watchFile } = require("atom")');
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
