// Sand Playground — challenge definitions
// Split out of sand-playground-engine.js; pure data/helpers, no engine state.

import { WATER, CONCRETE } from './sand-playground-constants.js';

export const CHALLENGES = {
    drain: {
        name: 'Drain the reservoir', hint: 'TNT only. Breach the lake bed into the tunnels below.',
        world: 'classic', tools: ['tnt'], tnt: 3,
        rects: [[232, 195, 257, 90]], mat: WATER, want: 'empty', frac: 0.2,
    },
    bridge: {
        name: 'Bring down the bridges', hint: 'Two bombs, two bridges.',
        world: 'canyon', tools: ['tnt'], tnt: 2,
        rects: [[207, 326, 76, 18], [517, 326, 76, 18]], mat: CONCRETE, want: 'empty', frac: 0.08,
    },
    flood: {
        name: 'Flood the bunker', hint: 'Vacuum only. Dig the lake a way down the hill.',
        world: 'bunker', tools: ['dig'], tnt: 0,
        rects: [[566, 171, 108, 50]], mat: WATER, want: 'fill', frac: 0.6,
    },
};

export const BEST_KEY = id => `pominigames:sandplayground:best.${id}`;
