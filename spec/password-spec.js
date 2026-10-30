describe("PDF password input ownership", () => {
  let viewer;

  beforeEach(() => {
    const PdfView = require("../lib/viewer");
    viewer = Object.create(PdfView.prototype);
    viewer.element = document.createElement("div");
    jasmine.attachToDOM(viewer.element);
  });

  afterEach(() => viewer.closePassword());

  it("submits a masked mini editor once and releases its registration", () => {
    const baseline = lumine.textEditors.getEditors().length;
    const reply = jasmine.createSpy("password reply");
    const form = viewer.showPassword(reply);
    const editor = viewer.passwordEditor;
    editor.setText("document secret");
    expect(editor.getElement().style.webkitTextSecurity).toBe("disc");
    expect(lumine.textEditors.getEditors().length).toBe(baseline + 1);
    lumine.commands.dispatch(editor.getElement(), "core:confirm");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(reply).toHaveBeenCalledOnceWith("document secret");
    expect(viewer.passwordElement).toBeNull();
    expect(editor.isDestroyed()).toBeTrue();
    expect(lumine.textEditors.getEditors().length).toBe(baseline);
  });

  it("cancels with Escape and retires an older password request", () => {
    const first = jasmine.createSpy("old password reply");
    const stale = viewer.showPassword(first);
    const editor = viewer.passwordEditor;
    const cancel = jasmine.createSpy("cancel opening");
    viewer.showPassword(jasmine.createSpy("new password reply"), 2, cancel);
    expect(editor.isDestroyed()).toBeTrue();
    expect(viewer.passwordElement.querySelector('[role="alert"]').textContent).toContain(
      "Incorrect password",
    );
    stale.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(first).not.toHaveBeenCalled();
    lumine.commands.dispatch(viewer.passwordEditor.getElement(), "core:cancel");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(viewer.passwordElement).toBeNull();
  });
});
