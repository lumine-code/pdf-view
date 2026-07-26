# pdf-view

Drives PDF viewers from another package: observe them, open one, look one up, scroll it to a named destination, or swap its file.

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Version     | `1.0.0`                                               |
| Provided by | `providePdfView()` returning the viewer API           |
| Consumed by | `consumePdfView(pdfView)`                             |
| Owner       | [`pdf-view`](https://github.com/lumine-code/pdf-view) |

Built for build tools: a LaTeX or Typst package compiles a document and needs the resulting PDF opened beside the source, kept in the same pane on recompile, and scrolled to the line the user was editing.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "pdf-view": {
      "versions": { "^1.0.0": "consumePdfView" }
    }
  }
}
```

## Contract

```ts
type PdfView = {
  hasIntegratedScrollmap: boolean;
  getViewers(): Set<Viewer>;
  observeViewers(callback: (viewer: Viewer) => void): Disposable;
  getViewerByPath(filePath: string): Viewer | null;
  getViewerByTag(tag: string): Viewer | null;
  open(filePath: string, options?: OpenOptions): Promise<Viewer>;
  scrollToDestination(viewer: Viewer, dest: string): void;
  setFile(viewer: Viewer, filePath: string, dest?: string, tag?: string): void;
};

type OpenOptions = {
  dest?: string;
  tag?: string;
  split?: "left" | "right" | "up" | "down";
  activatePane?: boolean;
};
```

| Member                                 | Description                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hasIntegratedScrollmap`               | `true` when the viewer draws its own scrollbar overview, so a scrollmap layer should stay out of its way. |
| `getViewers()`                         | Every open viewer.                                                                                        |
| `observeViewers(cb)`                   | Calls back for each existing viewer **and** each new one.                                                 |
| `getViewerByPath(path)`                | The viewer showing that file, or `null`.                                                                  |
| `getViewerByTag(tag)`                  | The viewer whose hash contains that tag, or `null`.                                                       |
| `open(filePath, options)`              | Opens the PDF. `split` defaults to `"right"` and `activatePane` to `false`.                               |
| `scrollToDestination(viewer, dest)`    | Scrolls an open viewer to a named destination.                                                            |
| `setFile(viewer, filePath, dest, tag)` | Points an existing viewer at a different file, keeping its pane.                                          |

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumePdfView(pdfView) {
    this.pdfView = pdfView;
    return new Disposable(() => (this.pdfView = null));
  },

  async showOutput(pdfPath) {
    const existing = this.pdfView?.getViewerByTag("my-build");
    if (existing) return this.pdfView.setFile(existing, pdfPath, null, "my-build");
    return this.pdfView?.open(pdfPath, { tag: "my-build", split: "right" });
  },
};
```

## Behavior

**Tag your viewers.** A `tag` is written into the URI hash and is how you find the same viewer again after a rebuild. Without one, `getViewerByPath` is the only handle — and it fails as soon as the output path changes.

Prefer `setFile` over closing and reopening. It keeps the pane, the scroll position, and the user's layout; reopening moves focus and loses their place.

`open` defaults to `activatePane: false`, which is correct for a build tool: the PDF appears without stealing focus from the source. It also searches all panes, so an already-open file is reused rather than duplicated.

`observeViewers` replays for existing viewers, so a package activating after a PDF is open still sees it.

Read `hasIntegratedScrollmap` before drawing your own scrollbar decorations on a viewer.

## Teardown

Return a `Disposable` that drops your reference and disposes any `observeViewers` subscription. **Do not destroy viewers you did not open** — and think twice about destroying ones you did, since the user may still be reading them.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
