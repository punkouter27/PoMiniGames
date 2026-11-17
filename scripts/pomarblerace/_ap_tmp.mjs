import { bootRace } from './harness.mjs';
for (const id of [2, 3, 5]) { const g = await bootRace(id, 1); console.log(id, JSON.stringify(g.track.containment.aprons || [])); g.dispose(); }
process.exit(0);
