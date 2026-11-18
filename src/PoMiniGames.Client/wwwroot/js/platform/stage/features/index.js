// Every shared stage feature. Adding a feature = one file in this folder + one line here.
// Defaults (on for every matching stage unless the game excludes them):
//   shake         any  camera shake driven by PoImpact trauma
// Opt-in (`use: [...]`):
//   renderBudget  3d   adaptive pixel ratio / shadow ladder (platform/renderBudget.js)
import './shake.js';
import './renderBudget.js';
