const main = require("../lib/main");

describe("pdf-view navigation adapter", () => {
  it("activates the viewer through the workspace before scrolling and focusing it", async () => {
    const item = {
      pdfjsPath: "viewer.html",
      scrollToDestination: jasmine.createSpy("scrollToDestination"),
    };
    const element = { focus: jasmine.createSpy("focus") };
    const header = { dest: "chapter-one" };
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve(item));
    spyOn(lumine.views, "getView").and.returnValue(element);

    await main.provideNavigationAdapter().navigateTo(item, header);

    expect(open).toHaveBeenCalledWith(item, { searchAllPanes: true });
    expect(item.scrollToDestination).toHaveBeenCalledWith(header);
    expect(element.focus).toHaveBeenCalled();
  });
});
