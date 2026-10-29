const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let runtime;
let library;
let stylesheet;
const styles = new WeakMap();
const root = path.dirname(require.resolve("pdfjs-dist/package.json"));

function assetURL(relative) {
  return pathToFileURL(path.join(root, relative)).href;
}

function getRuntime() {
  if (!runtime) {
    const library = getLibrary();
    const components = require("pdfjs-dist/web/pdf_viewer.mjs");
    runtime = { ...library, ...components };
  }
  return runtime;
}

function getLibrary() {
  if (!library) {
    const build = process.versions.electron ? "build" : "legacy/build";
    library = require(path.join(root, build, "pdf.mjs"));
    library.GlobalWorkerOptions.workerSrc = assetURL(`${build}/pdf.worker.mjs`);
  }
  return library;
}

function acquireStyles(document) {
  let entry = styles.get(document);
  if (!entry) {
    stylesheet ||= fs
      .readFileSync(path.join(root, "web/pdf_viewer.css"), "utf8")
      .replace(/:root\b/g, ":scope")
      .replace(
        /url\((["']?)(images\/[^)"']+)\1\)/g,
        (_, _quote, relative) => `url("${assetURL(`web/${relative}`)}")`,
      );
    const element = document.createElement("style");
    element.dataset.pdfViewStyles = "";
    element.textContent = `@scope (.pdf-view) {\n${stylesheet}\n}`;
    document.head.appendChild(element);
    entry = { element, count: 0 };
    styles.set(document, entry);
  }
  entry.count++;
  return {
    dispose() {
      if (!entry) return;
      if (--entry.count === 0) {
        entry.element.remove();
        styles.delete(document);
      }
      entry = null;
    },
  };
}

module.exports = { getRuntime, getLibrary, assetURL, acquireStyles };
