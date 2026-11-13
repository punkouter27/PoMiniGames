// lifecycle.js — birth, life stages, old age and death bookkeeping.
import { TRAITS } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { SPECIES } from './species.js';

export const LIFE_STAGE = Object.freeze({ JUVENILE: 0, ADULT: 1, ELDER: 2 });

export const DEATH_CAUSE = Object.freeze({
  STARVATION: 'starvation', DEHYDRATION: 'dehydration', OLD_AGE: 'old_age', PREDATION: 'predation', COMBAT: 'combat',
  FIRE: 'fire', LIGHTNING: 'lightning', ROCKFALL: 'rockfall', ERUPTION: 'eruption', DROWNING: 'drowning', DISEASE: 'disease', DEBUG: 'debug',
});

export const CAUSE_TEXT = Object.freeze({
  starvation: 'starved', dehydration: 'died of thirst', old_age: 'died of old age', predation: 'was killed', combat: 'fell in battle',
  fire: 'burned', lightning: 'was struck by lightning', rockfall: 'was crushed by a rock',
  eruption: 'was caught in the eruption', drowning: 'drowned', disease: 'succumbed to sickness',
  debug: 'vanished (debug)',
});

/**
 * Allocate and initialise a creature. Returns the index or -1 when the store is full
 * (the caller logs "Island is full").
 */
export function spawnCreature(e, { speciesId, x, z, tick, age = 0, sex = 0, traits = null, mother = NONE, father = NONE, name = '' }) {
  const i = e.alloc();
  if (i < 0) return -1;
  e.species[i] = speciesId;
  e.x[i] = x; e.z[i] = z; e.y[i] = 0;
  e.age[i] = age;
  e.sex[i] = sex;
  e.hunger[i] = 0.3; e.thirst[i] = 0.3; e.health[i] = 1;
  e.mother[i] = mother; e.father[i] = father;
  e.birthTick[i] = tick;
  e.names[i] = name;
  if (traits) e.traits.set(traits.subarray ? traits.subarray(0, TRAITS.length) : traits.slice(0, TRAITS.length), i * TRAITS.length);
  updateLifeStage(e, i, SPECIES[speciesId]);
  return i;
}

export function updateLifeStage(e, i, species) {
  const age = e.age[i];
  if (age < species.matureYears) {
    e.lifeStage[i] = LIFE_STAGE.JUVENILE;
    e.scale[i] = species.juvenileScale + (1 - species.juvenileScale) * (age / species.matureYears);
  } else {
    e.lifeStage[i] = age >= species.maxAgeYears * species.oldAgeStart ? LIFE_STAGE.ELDER : LIFE_STAGE.ADULT;
    e.scale[i] = 1;
  }
}

/**
 * Probability of dying of old age during `dt` seconds. Zero before oldAgeStart, a
 * quadratic hazard after it, certain at 115 % of max age.
 */
export function oldAgeDeathChance(e, i, species, dt) {
  const frac = e.age[i] / species.maxAgeYears;
  if (frac < species.oldAgeStart) return 0;
  if (frac >= 1.15) return 1;
  const t = (frac - species.oldAgeStart) / (1.15 - species.oldAgeStart);
  return Math.min(1, t * t * 0.15 * dt);
}

/** Death cause implied by the vitals, or null while the creature lives. */
export function checkVitals(e, i) {
  if (e.health[i] > 0) return null;
  return e.hunger[i] >= e.thirst[i] ? DEATH_CAUSE.STARVATION : DEATH_CAUSE.DEHYDRATION;
}

export function killCreature(e, i, cause, log, tick, extraText = '') {
  const sp = SPECIES[e.species[i]];
  const name = e.names[i] || `${sp.name} #${i}`;
  log.push({
    tick, kind: 'death', species: sp.id, cause, creature: e.handle(i),
    text: `${name} (${sp.name.toLowerCase()}) ${CAUSE_TEXT[cause] ?? 'died'}${extraText}`,
  });
  e.free(i);
}
