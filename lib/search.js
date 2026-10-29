const { EventEmitter } = require("node:events");

const MAX_TEXT_PAGES = 4;
const MAX_TEXT_CHARACTERS = 1024 * 1024;
const MAX_PRESENTED_PAGES = 6;
const MAX_PAGE_HIGHLIGHTS = 200;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// This also implements the small controller interface used by PDF.js's
// TextHighlighter. PDFFindController retains all page text and every match;
// the adapter instead keeps page counts and a bounded presentation window.
class PdfSearchAdapter {
  constructor(view) {
    this.view = view;
    this.canReplace = false;
    this.events = new EventEmitter();
    this.subscriptions = [];
    this.generation = 0;
    this.revision = 0;
    this.navigationGeneration = 0;
    this.cache = new Map();
    this.extractions = new Map();
    this.presentationTasks = new Map();
    this.presentedPages = new Map();
    this.state = { highlightAll: true };
    this.selected = { pageIdx: -1, matchIdx: -1 };
    this.pageMatches = [];
    this.pageMatchesLength = [];
    this.counts = [];
    this.total = 0;
    this.pending = false;
    this.highlightMatches = false;
    const onLoad = () => {
      if (this.options?.findPattern && !this.destroyed) {
        this.search(this.options).catch((error) => this.reportError(error));
      }
    };
    if (view.onDidLoad) this.subscriptions.push(view.onDidLoad(onLoad));
    if (view.onDidDestroy) this.subscriptions.push(view.onDidDestroy(() => this.dispose()));
    if (view.onDidChangeView) {
      this.subscriptions.push(view.onDidChangeView(() => this.refreshPresentation()));
    }
    this.bindEventBus();
  }

  bindEventBus() {
    if (this.bus || !this.view.eventBus) return;
    this.bus = this.view.eventBus;
    const onTextLayer = ({ pageNumber }) => this.requestPresentation(pageNumber - 1);
    this.bus.on("textlayerrendered", onTextLayer);
    this.subscriptions.push({ dispose: () => this.bus.off("textlayerrendered", onTextLayer) });
  }

  setDocument(document) {
    if (this.document === document) return;
    this.document = document;
    this.revision++;
    this.cache.clear();
    this.extractions.clear();
    this.reset();
    this.bindEventBus();
  }

  reset() {
    this.generation++;
    this.navigationGeneration++;
    this.counts = new Array(this.document?.numPages || 0).fill(-1);
    this.counting = new Map();
    this.total = 0;
    this.pending = false;
    this.current = null;
    this.selected = { pageIdx: -1, matchIdx: -1 };
    this.highlightMatches = false;
    this.scrollRequest = null;
    this.pageMatches = [];
    this.pageMatchesLength = [];
    this.presentedPages.clear();
    this.presentationTasks.clear();
    this.bus?.dispatch("updatetextlayermatches", { source: this, pageIndex: -1 });
    this.emitUpdate();
    this.events.emit("current");
  }

  async search(options = {}) {
    const snapshot = {
      findPattern: String(options.findPattern || ""),
      caseSensitive: Boolean(options.caseSensitive),
      wholeWord: Boolean(options.wholeWord),
      useRegex: Boolean(options.useRegex),
    };
    const key = JSON.stringify(snapshot);
    if (this.highlightMatches && key === this.queryKey) return this.searchPromise;
    this.options = snapshot;
    this.queryKey = key;
    this.reset();
    if (!snapshot.findPattern || this.destroyed) return;
    // Prefer the panel's compiler so newline escapes and word boundaries have
    // exactly the same meaning as they do in editor searches.
    this.expression =
      typeof options.getFindPatternRegex === "function"
        ? options.getFindPatternRegex()
        : this.compiledKey === key
          ? this.expression
          : compilePattern(snapshot);
    this.expression = new RegExp(this.expression.source, this.expression.flags.replace(/y/g, ""));
    if (!this.expression.global) {
      this.expression = new RegExp(this.expression.source, `${this.expression.flags}g`);
    }
    this.compiledKey = key;
    const generation = this.generation;
    this.highlightMatches = true;
    this.pending = true;
    this.emitUpdate();
    const scan = async () => {
      try {
        if (!this.document) await this.view.whenReady?.();
        this.check(generation);
        if (!this.document) return;
        for (let index = 0; index < this.counts.length; index++) {
          await this.ensureCount(index, generation);
          this.check(generation);
          if (this.isVisible(index)) this.requestPresentation(index);
          await pause();
        }
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      } finally {
        if (generation === this.generation) {
          this.pending = false;
          this.emitUpdate();
          this.events.emit("current");
        }
      }
    };
    this.searchPromise = scan();
    return this.searchPromise;
  }

  check(generation) {
    if (this.destroyed || this.view.destroyed || generation !== this.generation) {
      const error = new Error("Obsolete PDF search.");
      error.name = "AbortError";
      throw error;
    }
  }

  async pageData(index, generation) {
    this.check(generation);
    if (this.cache.has(index)) {
      const data = this.cache.get(index);
      this.cache.delete(index);
      this.cache.set(index, data);
      return data;
    }
    let request = this.extractions.get(index);
    if (!request) {
      const document = this.document;
      const revision = this.revision;
      request = (async () => {
        const page = await document.getPage(index + 1);
        const content = await page.getTextContent({ disableNormalization: true });
        const data = pageText(content.items);
        if (revision === this.revision && !this.destroyed) {
          if (data.size <= MAX_TEXT_CHARACTERS) this.cache.set(index, data);
          let characters = 0;
          for (const cached of this.cache.values()) characters += cached.size;
          while (this.cache.size > MAX_TEXT_PAGES || characters > MAX_TEXT_CHARACTERS) {
            const oldest = this.cache.keys().next().value;
            characters -= this.cache.get(oldest).size;
            this.cache.delete(oldest);
          }
        }
        return data;
      })();
      this.extractions.set(index, request);
      request
        .finally(() => {
          if (this.extractions.get(index) === request) this.extractions.delete(index);
        })
        .catch(() => {});
    }
    let data;
    try {
      data = await request;
    } catch (error) {
      // Replacing a document can terminate its in-flight PDF.js extraction.
      // Report that rejection only while the requesting search is current.
      this.check(generation);
      throw error;
    }
    this.check(generation);
    return data;
  }

  async iterate(data, generation, visitor) {
    const expression = new RegExp(this.expression.source, this.expression.flags);
    let match;
    let ordinal = 0;
    while ((match = expression.exec(data.text))) {
      if (visitor(match, ordinal++) === false) break;
      // RegExp.exec does not advance after an empty match. Advance one code
      // point with the Unicode flag, including at the end of the page.
      if (!match[0].length) {
        const point = data.text.codePointAt(expression.lastIndex);
        expression.lastIndex += expression.unicode && point > 0xffff ? 2 : 1;
      }
      if (ordinal % 1024 === 0) {
        await pause();
        this.check(generation);
      }
    }
    this.check(generation);
    return ordinal;
  }

  async ensureCount(index, generation) {
    this.check(generation);
    if (this.counts[index] >= 0) return this.counts[index];
    if (this.counting.has(index)) return this.counting.get(index);
    const request = (async () => {
      const data = await this.pageData(index, generation);
      const count = await this.iterate(data, generation, () => {});
      this.check(generation);
      if (this.counts[index] < 0) {
        this.counts[index] = count;
        this.total += count;
        this.emitUpdate();
      }
      return count;
    })();
    this.counting.set(index, request);
    return request;
  }

  getResultCount() {
    return this.total;
  }
  isPending() {
    return this.pending;
  }

  getCurrentResultIndex() {
    if (!this.current) return -1;
    let index = this.current.ordinal;
    for (let page = 0; page < this.current.page; page++) {
      if (this.counts[page] < 0) return -1;
      index += this.counts[page];
    }
    return index;
  }

  selectNext(options) {
    return this.navigate(1, options);
  }
  selectPrevious(options) {
    return this.navigate(-1, options);
  }
  selectFirstFromCursor(options) {
    return this.navigate(1, options, true);
  }

  async navigate(direction, { mode = "zone" } = {}, fromCursor = false) {
    const generation = this.generation;
    const navigation = ++this.navigationGeneration;
    try {
      if (!this.highlightMatches || !this.document) return { found: false, wrapped: null };
      let page =
        fromCursor || !this.current
          ? Math.max(0, (this.view.pdfViewer?.currentPageNumber || 1) - 1)
          : this.current.page;
      let ordinal =
        fromCursor || !this.current
          ? direction > 0
            ? 0
            : Infinity
          : this.current.ordinal + direction;
      let wrapped = null;
      for (let visited = 0; visited <= this.counts.length; visited++) {
        const count = await this.ensureCount(page, generation);
        this.check(generation);
        if (navigation !== this.navigationGeneration) return { found: false, wrapped: null };
        if (ordinal === Infinity) ordinal = count - 1;
        if (ordinal >= 0 && ordinal < count) {
          const data = await this.pageData(page, generation);
          let chosen;
          await this.iterate(data, generation, (match, candidate) => {
            if (candidate !== ordinal) return;
            chosen = originalMatch(data, match, candidate);
            return false;
          });
          if (navigation !== this.navigationGeneration) return { found: false, wrapped: null };
          const previousPage = this.current?.page;
          this.current = { page, ordinal, ...chosen };
          this.scrollRequest = { page, mode, generation };
          this.view.scrollAnimation?.cancel();
          this.view.interruptZoom?.();
          if (this.view.pdfViewer) this.view.pdfViewer.currentPageNumber = page + 1;
          await this.presentPage(page, generation);
          if (previousPage != null && previousPage !== page) this.requestPresentation(previousPage);
          this.events.emit("current");
          return { found: true, wrapped };
        }
        page += direction;
        if (page < 0 || page >= this.counts.length) {
          page = direction > 0 ? 0 : this.counts.length - 1;
          wrapped = direction > 0 ? "up" : "down";
        }
        ordinal = direction > 0 ? 0 : Infinity;
      }
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
    return { found: false, wrapped: null };
  }

  isVisible(index) {
    return this.onIsPageVisible
      ? this.onIsPageVisible(index + 1)
      : index === (this.view.pdfViewer?.currentPageNumber || 1) - 1;
  }

  refreshPresentation() {
    if (!this.highlightMatches) return;
    for (const index of this.presentedPages.keys()) {
      if (this.isVisible(index) && !this.pageMatches[index]) this.requestPresentation(index);
    }
    const current = (this.view.pdfViewer?.currentPageNumber || 1) - 1;
    if (this.counts[current] >= 0 && !this.pageMatches[current]) this.requestPresentation(current);
  }

  requestPresentation(index) {
    if (!this.highlightMatches || index < 0 || index >= this.counts.length) return;
    if (this.presentationTasks.has(index)) return;
    const generation = this.generation;
    const task = this.presentPage(index, generation);
    this.presentationTasks.set(index, task);
    task
      .catch((error) => this.reportError(error))
      .finally(() => {
        if (this.presentationTasks.get(index) === task) this.presentationTasks.delete(index);
      });
  }

  async presentPage(index, generation) {
    const data = await this.pageData(index, generation);
    const matches = [];
    const current = this.current?.page === index ? this.current : null;
    await this.iterate(data, generation, (match, ordinal) => {
      if (matches.length < MAX_PAGE_HIGHLIGHTS || ordinal === current?.ordinal) {
        matches.push(originalMatch(data, match, ordinal));
      }
      // The selected occurrence may be beyond the presentation budget.
      if (matches.length >= MAX_PAGE_HIGHLIGHTS && (!current || ordinal >= current.ordinal))
        return false;
    });
    if (current && current !== this.current) return;
    this.pageMatches[index] = matches.map((match) => match.index);
    this.pageMatchesLength[index] = matches.map((match) => match.length);
    if (current && current === this.current) {
      this.selected = {
        pageIdx: index,
        matchIdx: matches.findIndex((match) => match.ordinal === current.ordinal),
      };
    }
    this.presentedPages.delete(index);
    this.presentedPages.set(index, true);
    while (this.presentedPages.size > MAX_PRESENTED_PAGES) {
      const victim = Array.from(this.presentedPages.keys()).find(
        (page) => page !== this.current?.page,
      );
      this.presentedPages.delete(victim);
      delete this.pageMatches[victim];
      delete this.pageMatchesLength[victim];
      this.bus?.dispatch("updatetextlayermatches", { source: this, pageIndex: victim });
    }
    this.bus?.dispatch("updatetextlayermatches", { source: this, pageIndex: index });
  }

  scrollMatchIntoView({ element, pageIndex, matchIndex }) {
    const request = this.scrollRequest;
    if (
      !element ||
      !request ||
      request.generation !== this.generation ||
      request.page !== pageIndex ||
      this.selected.matchIdx !== matchIndex
    )
      return;
    this.scrollRequest = null;
    this.view.scrollAnimation?.cancel();
    this.view.interruptZoom?.();
    const viewport = this.view.viewport;
    if (!viewport?.getBoundingClientRect) return;
    const bounds = viewport.getBoundingClientRect();
    const match = element.getBoundingClientRect();
    const height = viewport.clientHeight || bounds.height;
    const top = match.top - bounds.top;
    let mode = request.mode;
    if (mode === "zone") mode = global.lumine?.config.get("editor.scrollZone") ?? [0, 50];
    if (mode === "nearest") mode = [0, 100];
    if (mode === "center") mode = 50;
    const values = Array.isArray(mode) ? mode : [typeof mode === "number" ? mode : 0];
    const first = Math.max(0, Math.min(100, values[0] ?? 0)) / 100;
    const last = Math.max(0, Math.min(100, values[1] ?? values[0] ?? 0)) / 100;
    const travel = Math.max(0, height - match.height);
    if (first === last || top < Math.min(first, last) * travel) {
      viewport.scrollTop += top - first * travel;
    } else if (top > Math.max(first, last) * travel) {
      viewport.scrollTop += top - last * travel;
    }
    if (match.left < bounds.left) viewport.scrollLeft += match.left - bounds.left;
    else if (match.right > bounds.right) viewport.scrollLeft += match.right - bounds.right;
  }

  hasSelectionMatchingResult() {
    return Boolean(this.current);
  }
  getSelectedText(options) {
    return this.view.getSelectedText?.(options) || "";
  }
  isSelectionEmpty() {
    return !this.getSelectedText();
  }
  getWordUnderCursor() {
    return "";
  }
  getWrapIconHost() {
    return this.view.viewport;
  }
  refresh() {
    return this.search(this.options);
  }
  deactivate() {
    this.reset();
  }
  onDidUpdate(callback) {
    return this.subscribe("update", callback);
  }
  onDidChangeCurrentResult(callback) {
    return this.subscribe("current", callback);
  }
  onDidError(callback) {
    return this.subscribe("did-error", callback);
  }
  subscribe(event, callback) {
    this.events.on(event, callback);
    return { dispose: () => this.events.off(event, callback) };
  }
  emitUpdate() {
    this.events.emit("update");
  }
  reportError(error) {
    if (!this.destroyed && error.name !== "AbortError") this.events.emit("did-error", error);
  }
  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reset();
    this.cache.clear();
    this.extractions.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.events.removeAllListeners();
  }
}

function compilePattern(options) {
  let pattern = options.useRegex
    ? options.findPattern
    : options.findPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  const unicode = Array.from(pattern).some((character) => character.codePointAt(0) > 127);
  return new RegExp(pattern, `gm${options.caseSensitive ? "" : "i"}${unicode ? "u" : ""}`);
}

function pageText(items) {
  const parts = [];
  const segments = [];
  let offset = 0;
  let original = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (item.str.length) segments.push({ offset, original, length: item.str.length });
    parts.push(item.str);
    offset += item.str.length;
    original += item.str.length;
    if (item.hasEOL) {
      parts.push("\n");
      offset++;
    }
  }
  return { text: parts.join(""), segments, size: offset + segments.length * 12 };
}

function originalOffset(data, offset) {
  let lower = 0;
  let upper = data.segments.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (data.segments[middle].offset <= offset) lower = middle + 1;
    else upper = middle;
  }
  const segment = data.segments[lower - 1];
  return segment ? segment.original + Math.min(segment.length, offset - segment.offset) : 0;
}

function originalMatch(data, match, ordinal) {
  const index = originalOffset(data, match.index);
  return { index, length: originalOffset(data, match.index + match[0].length) - index, ordinal };
}

module.exports = PdfSearchAdapter;
