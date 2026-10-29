# pdf-view

Open or reuse a PDF pane, navigate to a destination and preserve the reader's zoom through one awaited operation.

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Version     | `2.0.0`                                               |
| Provided by | `providePdfView()` returning the PDF service          |
| Consumed by | `consumePdfView(pdfView)`                             |
| Owner       | [`pdf-view`](https://github.com/lumine-code/pdf-view) |

## Registration

```json
{
  "consumedServices": {
    "pdf-view": {
      "versions": { "^2.0.0": "consumePdfView" }
    }
  }
}
```

## Contract

```ts
type PdfView = {
  readonly openerId: string;
  open(filePath: string, options?: OpenOptions): Promise<Viewer | null>;
};

type OpenOptions = {
  tag?: string;
  reuse?: boolean;
  dest?: string;
  destinationMode?: "destination" | "page";
  pane?: Pane;
  split?: "left" | "right" | "up" | "down";
  activatePane?: boolean;
  pending?: boolean;
  signal?: AbortSignal;
};
```

| Optional field    | Behavior                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`             | Identifies a reusable pane owned by the integration, independently of its current file. Use a stable name specific to the consumer.                                                 |
| `reuse`           | Defaults to `true`. Reuses the tagged viewer when a tag is supplied, otherwise a viewer of the same file. `false` creates an independent viewer without assigning the reusable tag. |
| `dest`            | Named PDF destination. Omit it to keep the existing position in the same file, or open a replacement file at its beginning.                                                         |
| `destinationMode` | `"destination"` follows the destination's coordinates; `"page"` opens the top of its containing page. Both retain the user's zoom. Defaults to `"destination"`.                     |
| `pane`            | Anchor pane captured by the caller. A reused viewer remains in its own pane.                                                                                                        |
| `split`           | Placement of a new viewer relative to the anchor. Defaults to `"right"` without an explicit pane; an explicit pane is used directly unless a split is requested.                    |
| `activatePane`    | Defaults to `false`. The requested tab becomes visible in its pane while source focus remains in place. `true` activates the PDF pane.                                              |
| `pending`         | Opens a new viewer as a pending item when the editor allows it.                                                                                                                     |
| `signal`          | Cancels the request with its abort reason. An unpresented viewer is disposed; an existing tab remains open.                                                                         |

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumePdfView(service) {
    this.pdfView = service;
    return new Disposable(() => {
      if (this.pdfView === service) this.pdfView = null;
    });
  },

  async showHelp(filePath, destination) {
    if (!this.pdfView) throw new Error("A PDF viewing service is required.");
    return this.pdfView.open(filePath, {
      tag: "my-package:help",
      dest: destination,
      destinationMode: "page",
      split: "right",
      activatePane: false,
    });
  },
};
```

## Behavior

The service owns lookup, creation, replacement, readiness, navigation and tab presentation. Callers do not search viewers, change their files or reveal their URIs separately. PDF destinations and integration tags are service arguments; callers must not encode integration metadata into a workspace opening or a file URI.

`openerId` identifies the provider's registered workspace path opener. A consumer offering an opener picker can use this public ID for a request-scoped opening override and invoke `open` with its own destination options when the PDF choice is selected. This avoids depending on a package name or replacing the opener globally. The viewing service currently supports help opening in the current native window.

Changing the file in a tagged viewer keeps the user's zoom mode or percentage and rotation. An identical file is not reloaded, and a request without a destination retains its position. Internal PDF links remain normal destination links. Standard PDF file URLs can still carry native PDF fragments when opened by the workspace.

The returned promise settles after placement, document readiness and requested navigation. It returns the live viewer, or `null` when the provider retires, the chosen pane closes or a newer request supersedes this request for the same viewer. Loading and current navigation failures reject. Cancellation rejects with the signal's reason. Overlapping requests for one tag share the initial pane placement; the latest request determines its document and destination.

Reusable tags are saved in the pane item's session state and restored with it. A user-created split copy is independent and does not inherit the integration's tag. The item URI continues to identify the source file.

## Teardown

The consumer drops its service reference when the provider edge is disposed. Service consumption is passive; it does not activate a named implementation. An unavailable service should be handled through the consumer's normal error channel. A retained service from a retired provider returns `null` and cannot create viewers in a later package generation.

## Versioning

`2.0.0` is provided and `^2.0.0` consumed. This replaces the version 1 lookup, mutation and observation API with one opening operation. Viewer observation used by other PDF-owned adapters remains an internal provider concern.
