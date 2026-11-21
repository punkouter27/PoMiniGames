// Every shared stage feature. Adding a feature = one file in this folder + one line here.
// Defaults (on for every matching stage unless the game excludes them):
//   shake         any  camera shake driven by PoImpact trauma
// Opt-in (`use: [...]`):
//   renderBudget  3d   adaptive pixel ratio / shadow ladder (platform/renderBudget.js)
//   paper         3d   loose paper on the ground, simulated on the GPU (platform/3d/paperField.js)
import './shake.js';
import './renderBudget.js';
import './paper.js';
