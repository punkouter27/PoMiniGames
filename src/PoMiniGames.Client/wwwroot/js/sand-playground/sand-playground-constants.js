// Sand Playground — grid, material and tuning constants
// Split out of sand-playground-engine.js; pure data/helpers, no engine state.

export const W = 800, H = 600;
export const AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;
export const MATBYTE = [0, 60, 120, 180, 240];
export const SAT_BYTE = 85;              // sand R byte for "pores hold one cell of water"
export const BEDROCK_TOP = 8;            // texture rows 0..7 are bedrock baseline
export const GRAVITY0 = 0.35;            // px/frame^2 for rigid projectiles
export const SLING_K = 0.085;            // drag distance -> launch speed
export const SLING_MAX = 13.5;           // px/frame launch speed cap
export const TNT_FUSE_MS = 5000;
export const TNT_BLAST_R = 63;     // 10x yield: energy scales with crater area (20 * sqrt(10))
export const TNT_SHATTER_R = 100;  // measured to the bar's nearest surface
// Line-of-sight budget for a blast ray (see detonate). Loose ground is
// blown through almost freely; concrete and bedrock shield hard, so ~12 px
// of wall stops a ray outright while 100 px of sand does not.
export const BLAST_SOLID_BUDGET = 120;
export const BALLOON_R = 13;
export const LW = 400, LH = 300;          // light/bloom working resolution
export const NP = 16384;
export const KIND = { spark: 1, dust: 2, mist: 3, bubble: 4, foam: 5 };
export const PAINT_TOOLS = ['dig', 'sand', 'water', 'fire'];
export const UNDO_DEPTH = 10; // ~1.9 MB a snapshot
export const SLOT_KEY = n => `pominigames:sandplayground:slot.${n}`;
export const SLOT_INDEX = 'sandplayground.slots';
export const UNIFORM_NAMES = ['u_state', 'u_aux', 'u_temp', 'u_seed', 'u_parity', 'u_time', 'u_dt', 'u_wind', 'u_disable', 'u_surgeDir',
    'u_light', 'u_heights', 'u_prev', 'u_lights', 'u_nlights',
    'u_scene', 'u_bloom', 'u_dir', 'u_texel', 'u_rings', 'u_nrings',
    'u_shake', 'u_flash',
    'u_k', 'u_sky', 'u_view', 'u_smoke', 'u_out', 'u_melt', 'u_old', 'u_src', 'u_nsrc'];
export const CANTILEVER_LIMIT = 35;
export const SPAN_LIMIT = 90;
export const TOOL_KEYS = ['dig', 'sand', 'water', 'fire', 'concrete', 'tnt', 'balloon', 'inspect'];
export const DAY_MS = 600000;
export const MAT_NAMES = ['Air', 'Sand', 'Concrete', 'Water', 'Bedrock'];
