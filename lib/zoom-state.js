// The zoom popup and command-menu aliases describe the same stored choice.
const ZOOM_MODES = [
  { label: "Automatic Zoom", command: "automatic-zoom", value: "auto-width" },
  { label: "Fit to View", command: "fit-to-view", value: "page-fit" },
  { label: "Fit Width", command: "fit-width", value: "page-width" },
];

function isZoomChoiceSelected(state, { mode: requestedMode, scale } = {}) {
  const mode = state.zoomMode || state.scaleValue;
  if (requestedMode) {
    return mode === requestedMode || (requestedMode === "auto-width" && mode === "auto");
  }
  return (
    Number.isFinite(scale) &&
    !ZOOM_MODES.some((preset) => preset.value === mode) &&
    !["auto", "page-height"].includes(mode) &&
    Math.abs(state.scale - scale) < 0.0005
  );
}

module.exports = { ZOOM_MODES, isZoomChoiceSelected };
