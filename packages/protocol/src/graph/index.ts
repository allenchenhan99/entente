/**
 * Graph object model — the explainable view of RelayGraph. Pure functions of `State` (+ events).
 * Interface: ./types.ts (frozen). Implementation: build / actions / narrate / story / describe.
 */
export * from './types.js';
export { buildGraph } from './build.js';
export { actionsFor } from './actions.js';
export { narrate } from './narrate.js';
export { storyFor, clockLabel } from './story.js';
export { describe } from './describe.js';
