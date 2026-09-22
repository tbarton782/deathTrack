/**
 * Fixed stat profiles for the nine named AI drivers (Req 5.7 / 11.6).
 *
 * **Authored design data.** The original game's per-driver difficulty tuning is
 * not recoverable from its assets, so each of the nine characters is given a
 * deterministic `{ skillTier, aggression }` profile here (rather than the
 * server's random assignment). Fixing them makes single-player opponents
 * reproducible and lets each character read as a distinct personality — from
 * cautious novices to relentless experts.
 *
 * Requirements: 5.7, 6.1, 6.2, 11.6
 */

import type { AICharacter, AIDriverConfig } from '../types/ai.js';

/** The nine named drivers, in a fixed display/grid order (the real roster). */
export const AI_CHARACTER_ORDER: readonly AICharacter[] = [
  'sly',
  'angel',
  'crimson',
  'maniac',
  'menace',
  'mega',
  'lurker',
  'melissa',
  'wrecker',
];

/**
 * Per-character fixed profile. Aggression is on the spec's 1–5 scale; skill tier
 * governs firing probability and hazard-detection radius (Req 6.2/6.4). The
 * spread covers all three tiers and the full aggression range so a field of all
 * nine is varied.
 */
export const AI_DRIVER_PROFILES: Readonly<Record<AICharacter, AIDriverConfig>> = {
  // Expert killers — high skill, high aggression.
  sly: { character: 'sly', skillTier: 'expert', aggression: 5 },
  maniac: { character: 'maniac', skillTier: 'expert', aggression: 4 },
  wrecker: { character: 'wrecker', skillTier: 'expert', aggression: 3 },
  // Standard mid-field — solid, mixed aggression.
  menace: { character: 'menace', skillTier: 'standard', aggression: 5 },
  crimson: { character: 'crimson', skillTier: 'standard', aggression: 4 },
  mega: { character: 'mega', skillTier: 'standard', aggression: 3 },
  // Novices — learning the ropes, lower aggression.
  lurker: { character: 'lurker', skillTier: 'novice', aggression: 3 },
  melissa: { character: 'melissa', skillTier: 'novice', aggression: 2 },
  angel: { character: 'angel', skillTier: 'novice', aggression: 1 },
};

/** The AI driver config for a named character. */
export function aiProfileFor(character: AICharacter): AIDriverConfig {
  return AI_DRIVER_PROFILES[character];
}
