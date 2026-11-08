# pdf-view.build-provider

Identify a PDF's source document and route compilation through its owning tools.

| Metadata    | Value                       |
| ----------- | --------------------------- |
| Version     | `1.0.0`                     |
| Provided by | Compiler and document tools |
| Consumed by | `pdf-view`                  |

## Registration

Tool packages declare `pdf-view.build-provider` in `providedServices` and expose a provider from their activation generation. PDF View consumes every provider and releases its subscriptions when that service edge disappears. The provider owns compiler discovery, source resolution, compile-on-save policy and communication with any build service; the viewer owns document presentation and its F12 and Alt+F12 commands.

```json
{
  "providedServices": {
    "pdf-view.build-provider": {
      "versions": { "1.0.0": "providePdfBuildProvider" }
    }
  }
}
```

## Contract

```ts
interface PdfBuildProvider {
  id: string;
  name: string;
  resolveSource(
    pdfPath: string,
    options: { signal: AbortSignal; sourcePath?: string },
  ): string | null | Promise<string | null>;
  canBuild(sourcePath: string): boolean;
  build(sourcePath: string): unknown | Promise<unknown>;
  canToggleCompileOnSave(sourcePath: string): boolean;
  isCompileOnSaveEnabled(sourcePath: string): boolean;
  toggleCompileOnSave(sourcePath: string): unknown | Promise<unknown>;
  isBuilding(pdfPath: string): boolean;
  onDidChangeBuilds(callback: () => void): Disposable;
  onDidChangeSources(callback: (change?: { pdfPath?: string }) => void): Disposable;
}
```

`id` is a stable provider identifier, normally its package name. `name` identifies the owning tools. `resolveSource` returns the canonical source path when the provider recognizes the PDF, or `null` otherwise. It may inspect files asynchronously and must honor cancellation. The optional `sourcePath` is a previously resolved hint for that same provider; it is not proof of ownership and must be verified. Providers do not borrow the active editor to identify a PDF.

`canBuild`, `canToggleCompileOnSave`, `isCompileOnSaveEnabled` and `isBuilding` are synchronous, side-effect-free queries of cached state. They must not perform filesystem discovery or start work. `canBuild` reports whether a resolved source can be compiled now. `canToggleCompileOnSave` reports whether its automatic compilation policy can be changed, and `isCompileOnSaveEnabled` supplies the checked menu state. `isBuilding` reports whether this provider is currently writing the given PDF, including preparation and result collection; several builds must keep it true until all matching work has finished. The viewer pauses automatic reloads while any provider reports that its PDF is being built.

`build` starts compilation and `toggleCompileOnSave` changes the source's automatic compilation policy through the provider's own implementation. PDF View treats their return values, including booleans, as opaque and reports thrown errors or promise rejections through its normal error channel. Compiler providers can call the shared Tasks service without exposing that service to PDF View. These actions leave focus and Tasks panel visibility unchanged.

Emit `onDidChangeBuilds` when cached compilation availability, compile-on-save policy or output-writing state changes. Emit `onDidChangeSources` when source ownership may have changed; an optional `pdfPath` limits rediscovery to that PDF. An omitted path requests rediscovery for all open PDFs. Both subscriptions return a `Disposable`.

## Resolution and lifetime

PDF View queries all registered providers when a PDF opens, loads, changes its path or changes on disk, when a provider arrives or disappears, and after a provider reports changed sources. It also resolves again before `pdf-view:compile` (F12) or `pdf-view:toggle-compile-on-save` (Alt+F12) runs. A new request cancels the previous one for that viewer. Replies from an obsolete document, removed provider or retired package generation are ignored.

Only one matching provider enables either action. Missing and ambiguous ownership leave them unavailable rather than selecting a provider by registration order. Command availability and checked state use the cached resolution and the corresponding provider queries, so opening menus or checking a key binding performs no filesystem discovery. Activity and policy events update reload coordination, availability and checked state without starting another ownership scan.

Source hints are preserved with copied and restored PDF panes, then verified again by the registered provider. Replacing the PDF in a pending pane or changing its path invalidates the previous document's hint and pending resolution. Disposing the provider removes it from routing immediately; callbacks retained from a retired activation must remain inert.
