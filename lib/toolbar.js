// The PDF.js component owns the pages; the host owns the viewing controls.
const ZOOM_LEVELS = require("./zoom-levels");
const { ZOOM_MODES, isZoomChoiceSelected } = require("./zoom-state");

class Toolbar {
  constructor(view) {
    this.view = view;
    this.document = view.element.ownerDocument;
    this.disposables = [];
    this.buttons = new Map();
    this.element = this.document.createElement("div");
    this.element.className = "pdf-view-controls";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "PDF viewing controls");
    this.group = this.document.createElement("div");
    this.group.className = "pdf-view-controls-group btn-group";
    const left = this.document.createElement("span");
    left.className = "pdf-view-controls-spacer";
    const right = left.cloneNode();
    this.element.append(left, this.group, right);
    this.listen(this.group, "contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.view.captureContext(event);
    });

    this.addButton("first-page", "<<", "First page");
    this.addButton("previous-page", "<", "Previous page");
    this.addButton("zoom-out", "-", "Zoom out");
    const pageField = this.document.createElement("label");
    pageField.className = "pdf-view-page-field btn";
    this.pageInput = this.document.createElement("input");
    this.pageInput.className = "pdf-view-page-input native-key-bindings";
    this.pageInput.type = "number";
    this.pageInput.min = "1";
    this.pageInput.step = "1";
    this.pageInput.setAttribute("aria-label", "Page number");
    this.pageInput.setAttribute("inputmode", "numeric");
    this.pageCount = this.document.createElement("span");
    this.pageCount.className = "pdf-view-page-count";
    pageField.append(this.pageInput, this.pageCount);
    this.group.append(pageField);
    this.listen(
      pageField,
      "wheel",
      (event) => {
        if (
          this.pageInput.disabled ||
          this.view.destroyed ||
          event.defaultPrevented ||
          !Number.isFinite(event.deltaY) ||
          event.deltaY === 0
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        this.view.goToPage(this.view.getCurrentPage() + Math.sign(event.deltaY));
        this.pageInput.value = String(this.view.getCurrentPage());
      },
      { passive: false },
    );
    this.listen(this.pageInput, "focus", () => this.pageInput.select());
    this.listen(this.pageInput, "change", () => this.commitPage(false));
    this.listen(this.pageInput, "keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") this.commitPage(true);
        else {
          this.pageInput.value = String(this.view.getViewState().page || 1);
          this.view.focus();
        }
      }
    });
    this.scaleField = this.document.createElement("label");
    this.scaleField.className = "pdf-view-zoom-value btn";
    this.scaleField.dataset.action = "automatic-zoom";
    this.scaleInput = this.document.createElement("input");
    this.scaleInput.className = "pdf-view-zoom-input native-key-bindings";
    this.scaleInput.type = "text";
    this.scaleInput.inputMode = "decimal";
    this.scaleInput.setAttribute("aria-label", "Zoom percentage");
    this.scaleInput.setAttribute("aria-haspopup", "menu");
    this.scaleInput.setAttribute("aria-expanded", "false");
    this.scaleField.append(this.scaleInput);
    this.group.append(this.scaleField);
    const scaleTooltip = lumine.tooltips.add(this.scaleField, {
      title: "Edit zoom percentage. Middle-click for Automatic Zoom. Right-click for zoom levels.",
      keyBindingCommand: "pdf-view:automatic-zoom",
      keyBindingTarget: this.view.element,
    });
    this.disposables.push(() => scaleTooltip.dispose());

    this.listen(this.scaleInput, "focus", () => {
      this.scaleEditStart = this.scaleInput.value;
      this.scaleInput.select();
    });
    this.listen(this.scaleInput, "blur", () => (this.scaleInput.value = this.lastScaleText));
    this.listen(this.scaleInput, "keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") this.commitScale();
        else this.view.focus();
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleZoomMenu();
      }
    });
    this.listen(this.scaleField, "mousedown", (event) => {
      // Select the whole value on entry, then let the user place the caret.
      if (
        event.button === 1 ||
        (event.button === 0 && this.scaleInput.ownerDocument.activeElement !== this.scaleInput)
      )
        event.preventDefault();
    });
    const resetZoom = (event) => {
      if (event.button !== 1 || this.scaleInput.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      this.view.focus();
      lumine.commands.dispatch(this.view.element, "pdf-view:automatic-zoom");
    };
    this.listen(this.scaleField, "click", (event) => {
      if (
        event.button === 0 &&
        !this.scaleInput.disabled &&
        this.scaleInput.ownerDocument.activeElement !== this.scaleInput
      ) {
        event.preventDefault();
        this.scaleInput.focus({ preventScroll: true });
      } else resetZoom(event);
    });
    this.listen(this.scaleField, "auxclick", resetZoom);
    this.listen(
      this.scaleField,
      "wheel",
      (event) => {
        if (
          this.scaleInput.disabled ||
          this.view.destroyed ||
          event.defaultPrevented ||
          !Number.isFinite(event.deltaY) ||
          event.deltaY === 0
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const pixels =
          event.deltaY *
          (event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? this.view.viewport.clientHeight
              : 1);
        this.view.zoomBy(Math.exp(-pixels * 0.002));
      },
      { passive: false },
    );
    this.listen(this.scaleField, "contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.view.captureContext(event);
      this.toggleZoomMenu();
    });
    this.addButton("zoom-in", "+", "Zoom in");
    this.addButton("next-page", ">", "Next page");
    this.addButton("last-page", ">>", "Last page");
    this.update();
  }

  listen(element, name, callback, options) {
    element.addEventListener(name, callback, options);
    this.disposables.push(() => element.removeEventListener(name, callback, options));
  }

  addButton(action, text, title) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = "btn native-key-bindings";
    button.dataset.action = action;
    button.textContent = text;
    button.setAttribute("aria-label", title);
    this.listen(button, "mousedown", (event) => event.preventDefault());
    this.listen(button, "click", (event) => {
      const keyboardFocus = event.detail === 0 && button.ownerDocument.activeElement === button;
      lumine.commands.dispatch(this.view.element, `pdf-view:${action}`);
      if (!keyboardFocus) this.view.focus();
    });
    const tooltip = lumine.tooltips.add(button, {
      title,
      keyBindingCommand: `pdf-view:${action}`,
      keyBindingTarget: this.view.element,
    });
    this.disposables.push(() => tooltip.dispose());
    this.buttons.set(action, button);
    this.group.append(button);
    return button;
  }

  toggleZoomMenu() {
    if (this.zoomMenu) {
      this.zoomMenu.close({ cancelled: true });
      return;
    }
    const state = this.view.getViewState();
    if (!state.pageCount) return;
    const template = ZOOM_MODES.map((preset) => ({
      label: preset.label,
      type: "radio",
      checked: isZoomChoiceSelected(state, { mode: preset.value }),
      command: `pdf-view:${preset.command}`,
    }));
    template.push({ type: "separator" });
    for (const scale of ZOOM_LEVELS) {
      template.push({
        label: `${scale * 100}%`,
        type: "radio",
        checked: isZoomChoiceSelected(state, { scale }),
        command: scale === 1 ? "pdf-view:zoom-100" : "pdf-view:set-zoom",
        commandDetail: scale === 1 ? undefined : { scale },
        keyBindingLabel: scale === 1 ? "0" : undefined,
      });
    }
    const menu = lumine.menu.showPopup({
      template,
      target: this.view.element,
      anchor: this.scaleField,
      placement: "below",
      alignment: "left",
      restoreFocusTarget: this.view.viewport,
      autoSelectFirstItem: true,
      className: "pdf-view-zoom-menu",
    });
    this.zoomMenu = menu;
    this.scaleInput.setAttribute("aria-expanded", "true");
    menu.onDidClose(() => {
      if (this.zoomMenu !== menu) return;
      this.zoomMenu = null;
      this.scaleInput.setAttribute("aria-expanded", "false");
    });
  }

  commitPage(focus) {
    const state = this.view.getViewState();
    const entered = Number(this.pageInput.value);
    const page =
      Number.isInteger(entered) && entered >= 1
        ? Math.min(entered, state.pageCount || 1)
        : state.page || 1;
    if (page !== state.page) this.view.goToPage(page);
    this.pageInput.value = String(page);
    if (focus) this.view.focus();
  }

  commitScale() {
    const value = this.scaleInput.value;
    this.view.focus();
    if (value === this.scaleEditStart) return this.view.stopAdaptiveZoom();
    const match = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*%?\s*$/.exec(value);
    if (match) {
      const scale = Number(match[1].replace(",", ".")) / 100;
      lumine.commands.dispatch(this.view.element, "pdf-view:set-zoom", { scale });
    }
  }

  update() {
    const state = this.view.getViewState();
    const ready = state.pageCount > 0;
    if (this.lastLoading !== Boolean(state.loading)) {
      this.lastLoading = Boolean(state.loading);
      this.element.classList.toggle("is-loading", this.lastLoading);
      this.element.setAttribute("aria-busy", String(this.lastLoading));
    }
    if (this.pageInput.disabled !== !ready) this.pageInput.disabled = !ready;
    const pageText = ready ? String(state.page) : "";
    if (
      this.element.ownerDocument.activeElement !== this.pageInput &&
      this.pageInput.value !== pageText
    ) {
      this.pageInput.value = pageText;
    }
    if (this.lastPageCount !== state.pageCount) {
      this.pageInput.max = String(state.pageCount || 1);
      this.pageInput.style.width = `${Math.max(2, String(state.pageCount || 1).length) + 1}ch`;
      this.pageCount.textContent = `/ ${state.pageCount || "–"}`;
      this.lastPageCount = state.pageCount;
    }
    const displayedScale = state.displayScale ?? state.scale;
    const scaleText = ready && displayedScale > 0 ? `${Math.round(displayedScale * 100)}%` : "–";
    this.lastScaleText = scaleText;
    if (this.scaleInput.disabled !== !ready) this.scaleInput.disabled = !ready;
    if (
      this.element.ownerDocument.activeElement !== this.scaleInput &&
      this.scaleInput.value !== scaleText
    ) {
      this.scaleInput.value = scaleText;
    }
    const zoomMode = state.zoomMode || state.scaleValue;
    if (this.scaleField.dataset.zoomMode !== zoomMode) this.scaleField.dataset.zoomMode = zoomMode;
    this.scaleField.classList.toggle("selected", ["auto-width", "auto"].includes(zoomMode));
    for (const [action, button] of this.buttons) {
      const disabled =
        !ready ||
        (["previous-page", "first-page"].includes(action) && state.page <= 1) ||
        (["next-page", "last-page"].includes(action) && state.page >= state.pageCount);
      if (button.disabled !== disabled) button.disabled = disabled;
    }
  }

  destroy() {
    this.zoomMenu?.close({ cancelled: true, restoreFocus: false });
    for (const dispose of this.disposables.splice(0)) dispose();
    this.element.remove();
    this.buttons.clear();
    this.view = null;
  }
}

module.exports = Toolbar;
