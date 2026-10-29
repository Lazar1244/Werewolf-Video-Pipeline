export * from './rng';
export * from './text';
export * from './api';
export * from './sim';
export { SUPPORTED_ROLES } from './game/script';
export { checkLegal } from './game/legal';
export type { Game, GameResult, SeatState } from './game/types';

/**
 * Engine version: part of every game's identity (ARCHITECTURE.md §5.6).
 * Bump whenever rules resolution, RNG use or text utilities change behaviour.
 */
export const ENGINE_VERSION = '0.4.0-m4';
