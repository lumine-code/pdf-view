const fs = require("fs");
const path = require("path");

describe("PDF viewer CSS role mapping", () => {
  let frame, document, view;
  beforeEach(() => {
    frame = window.document.createElement("iframe");
    jasmine.attachToDOM(frame);
    document = frame.contentDocument;
    view = document.defaultView;
    for (const file of ["vendors/pdfjs-dist/web/viewer.css", "vendors/custom/viewer.css"]) {
      const style = document.createElement("style");
      style.textContent = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      document.head.appendChild(style);
    }
    for (const [name, value] of Object.entries({
      "text-color": "rgb(10, 20, 30)",
      "text-color-selected": "rgb(230, 240, 250)",
      "background-color-selected": "rgb(40, 50, 60)",
      "background-color-highlight": "rgb(200, 210, 220)",
      "tab-background-color-active": "rgb(180, 190, 200)",
      "pane-item-border-color": "rgb(150, 160, 170)",
      "input-background-color": "rgb(100, 110, 120)",
      "input-border-color": "rgb(70, 80, 90)",
      "overlay-background-color": "rgb(30, 40, 50)",
      "overlay-border-color": "rgb(60, 70, 80)",
      "accent-indicator-color": "rgb(120, 130, 140)",
    }))
      document.documentElement.style.setProperty(`--${name}`, value);
    document.body.innerHTML =
      '<button class="toolbarButton toggled">Toggle</button><label class="toggleButton"><input type="checkbox" checked>Option</label><input class="toolbarField"><div class="doorHanger">Menu</div><div class="treeView"><div class="treeItem selected"><a href="#item">Item</a></div></div>';
  });
  afterEach(() => frame.remove());

  it("keeps selected text and icon masks on their matching fill even when focused", () => {
    const button = document.querySelector("button");
    button.focus();
    expect(view.getComputedStyle(button).color).toBe("rgb(230, 240, 250)");
    expect(view.getComputedStyle(button).backgroundColor).toBe("rgb(40, 50, 60)");
    expect(view.getComputedStyle(button, "::before").backgroundColor).toBe("rgb(230, 240, 250)");
    const toggle = document.querySelector("label");
    expect(view.getComputedStyle(toggle).color).toBe("rgb(230, 240, 250)");
    expect(view.getComputedStyle(toggle).backgroundColor).toBe("rgb(40, 50, 60)");
    expect(view.getComputedStyle(document.querySelector("a")).color).toBe("rgb(230, 240, 250)");
    expect(view.getComputedStyle(document.querySelector("a")).backgroundColor).toBe(
      "rgb(40, 50, 60)",
    );
  });

  it("uses input and overlay component palettes and the accent focus border", () => {
    const input = document.querySelector(".toolbarField");
    expect(view.getComputedStyle(input).backgroundColor).toBe("rgb(100, 110, 120)");
    expect(view.getComputedStyle(input).borderTopColor).toBe("rgb(70, 80, 90)");
    input.focus();
    expect(view.getComputedStyle(input).borderTopColor).toBe("rgb(120, 130, 140)");
    const menu = view.getComputedStyle(document.querySelector(".doorHanger"));
    expect(menu.backgroundColor).toBe("rgb(30, 40, 50)");
    expect(menu.boxShadow).toContain("rgb(60, 70, 80)");
  });
});
