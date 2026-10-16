describe("PDF command scope", () => {
  let main, workspace, viewer;

  beforeEach(() => {
    workspace = lumine.workspace.getElement();
    jasmine.attachToDOM(workspace);
    const pack = lumine.packages.loadPackage("pdf-view");
    pack.requireMainModule();
    main = pack.mainModule;
    main.activate();
    const element = document.createElement("div");
    element.className = "pdf-view";
    workspace.appendChild(element);
    viewer = { element, sendCommand: jasmine.createSpy("send viewer command") };
    main.viewers.add(viewer);
  });

  afterEach(() => {
    main.viewers.delete(viewer);
    viewer.element.remove();
    main.deactivate();
  });

  it("keeps viewer operations local while reload-all remains global", () => {
    for (const command of ["pdf-view:refresh", "pdf-view:next-page", "pdf-view:copy"])
      expect(lumine.commands.canDispatch(workspace, command)).toBe(false);
    expect(lumine.commands.canDispatch(workspace, "pdf-view:reload-all")).toBe(true);
    expect(lumine.commands.canDispatch(viewer.element, "pdf-view:next-page")).toBe(true);
  });

  it("dispatches to the targeted viewer without borrowing the active item", () => {
    const active = spyOn(lumine.workspace, "getActivePaneItem");
    lumine.commands.dispatch(viewer.element, "pdf-view:next-page");
    expect(viewer.sendCommand).toHaveBeenCalledWith("next-page");
    expect(main.viewerForEvent({ target: workspace })).toBeNull();
    expect(active).not.toHaveBeenCalled();
  });
});
