# pdf-view

View PDF files directly in the editor.

Built on Mozilla's PDF.js with theme integration, SyncTeX support, and a document outline.

## Features

- **PDF.js viewer**: renders pdf files in editor panes with Mozilla's PDF.js.
- **Theme integration**: mirrors the active Lumine UI and syntax theme colors into the viewer.
- **Auto-reload**: watches the file on disk and refreshes when it changes.
- **LaTeX and Typst**: compiles `.tex` and `.typ` sources and follows SyncTeX jumps when the matching tools packages are installed.
- **Build coordination**: pauses auto-refresh during a compile and reloads once the build finishes.
- **Document outline**: exposes the pdf outline to the navigation panel and tracks the active section while scrolling.
- **Scrollmap**: draws outline markers on the scrollbar when the scrollmap package is available.

## Installation

To install `pdf-view` search for _pdf-view_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/pdf-view`.

## Commands

Commands available in `lumine-workspace`:

- `pdf-view:reload-all`: reload all open PDF viewers,
- `pdf-view:refresh`: refresh content for the current viewer,
- `pdf-view:toggle-refreshing`: toggle auto-refresh for the current viewer,
- `pdf-view:compile`: compile the source `.typ` or `.tex` file,
- `pdf-view:open-tex`: open the corresponding `.typ` or `.tex` source file,
- `pdf-view:next-page`: go to the next page,
- `pdf-view:previous-page`: go to the previous page,
- `pdf-view:first-page`: go to the first page,
- `pdf-view:last-page`: go to the last page,
- `pdf-view:scroll-up`: scroll up,
- `pdf-view:scroll-down`: scroll down,
- `pdf-view:scroll-left`: scroll left,
- `pdf-view:scroll-right`: scroll right,
- `pdf-view:page-up`: scroll up by one viewport,
- `pdf-view:page-down`: scroll down by one viewport,
- `pdf-view:zoom-in`: zoom in,
- `pdf-view:zoom-out`: zoom out,
- `pdf-view:zoom-reset`: reset zoom,
- `pdf-view:page-width`: fit the page width to the viewer,
- `pdf-view:page-fit`: fit the whole page in the viewer,
- `pdf-view:page-actual`: show the page at its actual size,
- `pdf-view:scroll-mode-vertical`: scroll pages vertically,
- `pdf-view:scroll-mode-horizontal`: scroll pages horizontally,
- `pdf-view:scroll-mode-wrapped`: scroll pages wrapped,
- `pdf-view:scroll-mode-page`: scroll one page at a time,
- `pdf-view:spread-none`: show single pages,
- `pdf-view:spread-odd`: show spreads starting on odd pages,
- `pdf-view:spread-even`: show spreads starting on even pages,
- `pdf-view:rotate-clockwise`: rotate clockwise,
- `pdf-view:rotate-counterclockwise`: rotate counterclockwise,
- `pdf-view:select-tool`: enable the text selection tool,
- `pdf-view:hand-tool`: enable the hand tool,
- `pdf-view:find`: open find,
- `pdf-view:find-next`: find next match,
- `pdf-view:find-previous`: find previous match,
- `pdf-view:copy`: copy the selected text to the clipboard,
- `pdf-view:toggle-sidebar`: toggle the PDF sidebar,
- `pdf-view:presentation-mode`: enter presentation mode,
- `pdf-view:download`: download the PDF,
- `pdf-view:print`: print the PDF.

## Style

The viewer adapts its colors to the active Lumine theme. When the theme changes, the viewer's menu and chrome colors update to match.

## Document outline

The viewer exposes its document outline through the `navigation.adapter` service, so a navigation panel can search the outline tree instead of the built-in PDF.js outline. Scroll position is tracked and the active section is highlighted in the panel.

## URI options

The viewer accepts additional options when opening a PDF: open on a specific page, set the initial zoom level, jump to a named destination, or choose a sidebar state. For more information, see [pdf.js viewer options](https://github.com/mozilla/pdf.js/wiki/Viewer-options).

## LaTeX

With a `latex-tools` package installed, the viewer integrates compilation and SyncTeX support:

- **Compile**: compile the corresponding `.tex` file directly from the viewer.
- **Forward SyncTeX** (source → PDF): triggered from the editor.
- **Backward SyncTeX** (PDF → source): right-click a location in the PDF.
- **Build coordination**: auto-refresh pauses during compilation and resumes when the build finishes.

For PDF files created by TeX using the `--synctex=1` option, clicking on the PDF jumps to the corresponding source code.

## Typst

With a `typst-tools` package installed, the viewer integrates Typst compilation:

- **Compile**: compile the corresponding `.typ` file directly from the viewer.
- **Open source**: use `pdf-view:open-tex` to open the `.typ` source file.
- **Build coordination**: auto-refresh pauses during compilation and resumes when the build finishes.

When both `.typ` and `.tex` source files exist, the Typst source takes priority.

## Services

- **[pdf-view](docs/pdf-view.md)** (`1.0.0`): provided to let other packages manage PDF viewers programmatically — observe viewer instances, open PDFs in a split, look them up by path or tag, scroll to named destinations, and swap a viewer's file.
- **navigation.adapter** (`1.0.0`): provided to expose the PDF document outline to a navigation panel, following the `handlesItem` / `observeHeaders` / `navigateTo` protocol.
- **latex-tools** (`^1.0.0`): consumed to compile `.tex` sources and resolve SyncTeX positions for backward search.
- **typst-tools** (`^1.0.0`): consumed to compile `.typ` sources.
- **scrollmap.widget** (`^1.0.0`): consumed to draw PDF outline markers on the scrollbar.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
