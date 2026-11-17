# cannon-es (vendored)

Rigid-body physics for PoBrawl, PoMarbleRace, PoVoxelStrike, PoEcosystem and the
Sand Playground. Served from this folder so the import map in `index.html` can
resolve the bare specifier `cannon-es` to a same-origin file — no CDN, no npm
install on the client, and the PWA service worker can precache it.

| | |
|---|---|
| Upstream | https://github.com/pmndrs/cannon-es |
| Licence | MIT — see [LICENSE](./LICENSE) |
| Version | 0.20.0. The shipped bundle carries no version banner; the code comments in `wwwroot/js/pomarblerace/track-glb.js` pin the behaviour to 0.20, and the Octree workaround documented there is specific to that line. Re-check those comments before replacing the file. |
| Build | the published ESM bundle, unmodified |

Vendored rather than packaged because the client is a trimmed Blazor WASM app
with no bundler: a bare npm dependency would need a build step the project does
not have.

**To upgrade:** drop the new bundle in place, re-run the PoMarbleRace and
PoVoxelStrike JS suites, and re-read the `cannon-es` notes in
`wwwroot/js/pomarblerace/track-glb.js` (Octree AABB early-out, Int16 index limit,
no continuous collision detection).
