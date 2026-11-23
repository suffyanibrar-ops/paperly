/* Runs before first paint so a saved theme never flashes the other one. */
(function () {
  try {
    var key = "paperly.theme.v1";
    var saved = localStorage.getItem(key);
    var theme = saved === "light" || saved === "dark" ? saved : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    /* private mode or blocked storage — the CSS default (light) applies */
  }
})();
