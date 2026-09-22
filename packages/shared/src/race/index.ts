/**
 * Single-player race runtime: the headless race loop, the starting-grid
 * builder, and the fixed AI-driver profiles.
 */

export {
  RaceLoop,
  type RaceLoopConfig,
  type RaceParticipant,
  type ParticipantRaceOutcome,
} from './RaceLoop.js';

export {
  buildStartingGrid,
  GRID_SPACING,
  type StartingGrid,
  type BuildGridOptions,
} from './startingGrid.js';

export { AI_DRIVER_PROFILES, AI_CHARACTER_ORDER, aiProfileFor } from './aiProfiles.js';
