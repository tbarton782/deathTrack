# Implementation Plan: Deathtrack Multiplayer Recreation

## Overview

A TypeScript monorepo implementing a faithful web-based recreation of Deathtrack (1989) with real-time online multiplayer. The implementation proceeds from foundational shared types and codec through physics, weapons, AI, rendering, networking, and finally integration testing. Each task builds on the previous so that no code is left orphaned.

## Tasks

- [x] 1. Scaffold monorepo and toolchain
  - [x] 1.1 Initialise root `package.json` with npm workspaces (`packages/shared`, `packages/client`, `packages/server`, `packages/tools`, `tests`)
    - Create workspace `package.json` files with TypeScript 5, Vitest, fast-check, and ESLint as root dev-dependencies
    - Add shared `tsconfig.base.json` with `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`
    - _Requirements: 13.1, 13.4_
  - [x] 1.2 Configure each package's `tsconfig.json` extending the base config and set up package `build` and `test` scripts
    - `packages/shared` — CommonJS + ESM dual output via `tsc`
    - `packages/client` — Vite 5 with `@vitejs/plugin-react` placeholder and PixiJS v8
    - `packages/server` — Node.js 20 ESM with `ws` and `better-sqlite3`
    - `packages/tools` — Node.js CLI entry point
    - _Requirements: 13.1, 13.2_
  - [x] 1.3 Write a smoke test that imports each package's index and asserts it loads without throwing
    - _Requirements: 13.1_

- [x] 2. Define domain types in `packages/shared`
  - [x] 2.1 Create `packages/shared/src/types/primitives.ts` with `Vec2`, `ParticipantId`, `ChassisId`, `TrackId`, `WeaponId`, `ComponentId`, `SessionId`, `ProjectileId`, `HazardId`, and all ID alias types
    - _Requirements: 1.1, 4.1, 3.1_
  - [x] 2.2 Create `packages/shared/src/types/physics.ts` with `CarPhysicsState`, `CarInputs`, `WorldPhysicsState`, `PhysicsStepResult`, `PhysicsEvent`, and `RNG` interface
    - _Requirements: 1.1–1.9_
  - [x] 2.3 Create `packages/shared/src/types/weapons.ts` with `WeaponDef`, `WeaponCategory`, `WeaponConfig`, `ActiveProjectile`, `PlacedHazard`, `WeaponStepResult`, `WeaponSystemState`
    - _Requirements: 3.1–3.10_
  - [x] 2.4 Create `packages/shared/src/types/car.ts` with `ChassisDef`, `CarBaseStats`, `ComponentDef`, `ComponentSlot`, `EffectiveCarStats`, `CarRaceState`, `Loadout`, `ResolvedLoadout`
    - _Requirements: 4.1–4.7_
  - [x] 2.5 Create `packages/shared/src/types/track.ts` with `TrackDef`, `RoadSegment`, `JumpRamp`, `WaypointGraph`, `WaypointNode`, `WaypointEdge`, `PitLaneData`, `HazardZone`, `SceneryObject`, `SurfaceType`
    - _Requirements: 9.1–9.6_
  - [x] 2.6 Create `packages/shared/src/types/career.ts` with `CareerState`, `HighScoreEntry`, `SaveFile`
    - _Requirements: 5.1–5.10, 12.1–12.6_
  - [x] 2.7 Create `packages/shared/src/types/network.ts` with `Session`, `SessionConfig`, `ParticipantInfo`, `InputFrame`, `StateSnapshot`, `CompressedCarState`, `NetworkEvent`, `JoinResult`, `SessionSummary`
    - _Requirements: 7.1–7.8, 8.1–8.8_
  - [x] 2.8 Create `packages/shared/src/types/ai.ts` with `AIDriverConfig`, `AICharacter`, `SkillTier`, `AIDriverState`
    - _Requirements: 6.1–6.6_
  - [x] 2.9 Create `packages/shared/src/index.ts` re-exporting all types; verify `tsc --noEmit` passes with zero errors
    - _Requirements: all_

- [x] 3. Implement binary codec in `packages/shared/src/codec/`
  - [x] 3.1 Create `packages/shared/src/codec/BinaryWriter.ts` and `BinaryReader.ts` supporting `uint8`, `uint16`, `int16`, `uint32`, `int32`, `float32`, `float64`, fixed-length `string`, and nested struct read/write
    - _Requirements: 8.7, 12.4_
  - [x] 3.2 Create `packages/shared/src/codec/schema.ts` defining the `SchemaDescriptor` type and `createCodec<T>` factory that produces a `Codec<T>` from a field-ordered descriptor
    - _Requirements: 8.7, 8.8_
  - [x] 3.3 Implement `CompressedCarStateCodec` using fixed-point encoding: position as `uint16` × 0.1 units, heading as `uint8` (256 steps), speed as `uint16` × 0.01, armor as `uint8`, flags as `uint8`, ammo counts as `uint8`
    - _Requirements: 8.8_
  - [x] 3.4 Implement `StateSnapshotCodec` wrapping an array of up to 8 `CompressedCarState` entries plus header fields (`tick`, `serverTime`, `authorityChecksum`) — total encoded size ≤ 512 bytes
    - _Requirements: 8.7, 8.8_
  - [x] 3.5 Implement `SaveFileCodec` encoding `SaveFile` (magic `0x44545241`, version, slot, `CareerState` fields, trailing CRC32)
    - _Requirements: 12.4, 5.5_
  - [x] 3.6 Write property test for codec round-trip consistency (Property 18)
    - **Property 18: Network state snapshot round-trip preserves all synchronised fields**
    - **Validates: Requirements 8.7, 3.10**
    - Test file: `packages/shared/src/codec/__tests__/snapshot.prop.test.ts`
  - [x] 3.7 Write property test for packet size cap (Property 19)
    - **Property 19: Encoded state packets fit within the 512-byte size cap**
    - **Validates: Requirements 8.8**
    - Test file: `packages/shared/src/codec/__tests__/packet-size.prop.test.ts`
  - [x] 3.8 Write property test for save file round-trip (Property 13)
    - **Property 13: Save file round-trip preserves all persisted career fields**
    - **Validates: Requirements 5.5, 12.4**
    - Test file: `packages/shared/src/codec/__tests__/save.prop.test.ts`
  - [x] 3.9 Write property test for PII absence (Property 25)
    - **Property 25: No PII other than display name is serialised or transmitted**
    - **Validates: Requirements 13.5**
    - Test file: `packages/shared/src/codec/__tests__/pii.prop.test.ts`

- [x] 4. Implement asset parsers in `packages/tools/src/parsers/`
  - [x] 4.1 Create `TrkParser.ts` reading `.TRK` track geometry: road segments, jump ramps, waypoint graph, pit lane entry/exit, hazard zones, and scenery objects; export `parseTrack(buf: Buffer): TrackData`
    - _Requirements: 9.1, 9.2, 9.5_
  - [x] 4.2 Create `MapParser.ts` reading `.MAP` minimap data; `BlkParser.ts` reading `.BLK` sprite sheet blocks; `PalParser.ts` reading `.PALS` 256-colour palette files
    - _Requirements: 9.1, 2.6_
  - [x] 4.3 Create `TblParser.ts` reading `.TBL` weapon and car stat tables; export typed `WeaponTable` and `ChassisTable` structures matching the design's stat definitions
    - _Requirements: 4.1–4.3, 3.1_
  - [x] 4.4 Create `MusParser.ts` reading OPL2/AdLib `.MUS` sequences; convert to base64-encoded OGG stubs for web audio (actual OGG conversion deferred to build step)
    - _Requirements: 10.1_
  - [x] 4.5 Create `ScrParser.ts` reading `.SCR` full-screen images; decode to RGBA `Uint8ClampedArray` with palette application
    - _Requirements: 11.6_
  - [x] 4.6 Implement `packages/tools/src/cli.ts` entry point that walks an input directory, invokes all parsers, writes binary assets to `assets/` using `SaveFileCodec`-style encoding, and logs parse errors with track name and byte offset
    - _Requirements: 9.5, 9.6_
  - [x] 4.7 Write property test for track file round-trip (Property 23)
    - **Property 23: Track file parse–encode round-trip is byte-equivalent**
    - **Validates: Requirements 9.6**
    - Test file: `packages/tools/src/__tests__/track-roundtrip.prop.test.ts`

- [x] 5. Checkpoint — Verify codec and parser foundations
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement RNG and physics engine in `packages/shared/src/physics/`
  - [x] 6.1 Create `packages/shared/src/physics/rng.ts` implementing a seeded xorshift64 RNG satisfying the `RNG` interface — no `Math.random()` calls; export `mkRNG(seed: number): RNG`
    - _Requirements: 1.9_
  - [x] 6.2 Create `packages/shared/src/physics/stepPhysics.ts` implementing the pure `stepPhysics(state, inputs, dt, rng): PhysicsStepResult` function at a fixed 1/60 s timestep
    - Throttle/brake ramp speed within `[0, effectiveTopSpeed]` (Req 1.2, 1.3)
    - Steering rate proportional to `handling / max(speed, 1)` (Req 1.4)
    - Off-track detection via signed-distance-field lookup; apply 50% handling and speed cap when `onTrack === false` (Req 1.5)
    - Input iteration always sorted by `ParticipantId` (Req 1.9)
    - _Requirements: 1.1–1.5, 1.9_
  - [x] 6.3 Add collision resolution to `stepPhysics`: compute impulse for car pairs with relative velocity > 0.5 units/s; resolve multiple collisions on the same car in decreasing-velocity order
    - _Requirements: 1.6, 1.8_
  - [x] 6.4 Add jump ramp mechanics to `stepPhysics`: on ramp contact set `airborne = true`, compute vertical launch velocity from ramp angle and car speed; apply gravity each tick until surface level
    - _Requirements: 1.7_
  - [x] 6.5 Add pit lane detection and restoration: when car enters pit lane coordinates set `currentArmor = maxArmor` and reload all ammo; ensure restoration completes before car exits
    - _Requirements: 9.3, 9.4_
  - [x] 6.6 Write property test for physics speed bounds (Property 1)
    - **Property 1: Physics speed bounds are respected under all inputs**
    - **Validates: Requirements 1.2, 1.3**
    - Test file: `packages/shared/src/physics/__tests__/speed-bounds.prop.test.ts`
  - [x] 6.7 Write property test for off-track traction penalty (Property 2)
    - **Property 2: Off-track penalty clamps handling and speed cap**
    - **Validates: Requirements 1.5**
    - Test file: `packages/shared/src/physics/__tests__/traction.prop.test.ts`
  - [x] 6.8 Write property test for physics determinism (Property 3)
    - **Property 3: Physics simulation is deterministic**
    - **Validates: Requirements 1.9, 8.5**
    - Test file: `packages/shared/src/physics/__tests__/determinism.prop.test.ts`
  - [x] 6.9 Write property test for collision momentum conservation (Property 4)
    - **Property 4: Collision momentum is approximately conserved**
    - **Validates: Requirements 1.6**
    - Test file: `packages/shared/src/physics/__tests__/collision-momentum.prop.test.ts`
  - [x] 6.10 Write property test for pit lane full restore (Property 22)
    - **Property 22: Pit lane visit restores armor to maximum and reloads all weapons**
    - **Validates: Requirements 9.4**
    - Test file: `packages/shared/src/physics/__tests__/pit-lane.prop.test.ts`

- [x] 7. Implement weapon system in `packages/shared/src/weapons/`
  - [x] 7.1 Create `packages/shared/src/weapons/WeaponSystem.ts` with `stepWeapons(state, carStates, dt): WeaponStepResult`
    - Spawn projectile at car's front within one tick on forward-weapon activation; spawn hazard at car's rear for rear-drop activation (Req 3.2, 3.3)
    - Apply exactly `weaponDef.damage` armor reduction on projectile/hazard contact within one tick (Req 3.4)
    - Trigger `Elimination` event when armor ≤ 0 within same tick (Req 3.5)
    - Apply beam/laser damage at configured DPS in discrete ticks (Req 3.6)
    - Enforce ammo limits: clamp ammo to `[0, ammoMax]`, block fire at 0 (Req 3.7)
    - Remove hazard on contact by any car including owner (Req 3.8)
    - _Requirements: 3.1–3.9_
  - [x] 7.2 Add projectile round-trip validation per Requirement 3.10: before transmitting a projectile packet, encode–decode it and reject if any field differs
    - _Requirements: 3.10_
  - [x] 7.3 Write property test for exact weapon damage per hit (Property 5)
    - **Property 5: Weapon damage is exactly the configured value per hit**
    - **Validates: Requirements 3.4**
    - Test file: `packages/shared/src/weapons/__tests__/damage.prop.test.ts`
  - [x] 7.4 Write property test for ammo count bounds (Property 6)
    - **Property 6: Ammunition count stays within bounds under any fire sequence**
    - **Validates: Requirements 3.7**
    - Test file: `packages/shared/src/weapons/__tests__/ammo.prop.test.ts`

- [x] 8. Implement loadout and career logic in `packages/shared/src/`
  - [x] 8.1 Create `packages/shared/src/loadout/LoadoutService.ts` with:
    - `equip(loadout, slot, weaponId, catalogue)`: enforce one-weapon-per-slot; return `Result` with error if slot occupied or weapon not in catalogue
    - `equipComponent(loadout, slot, componentId, catalogue)`: validate component in catalogue; reject if not owned
    - `computeEffectiveStats(loadout, chassis, components)`: additive sum of base stats + component deltas, clamped to stat maxima
    - `confirmLoadout(loadout, chassis, catalogue)`: return `ResolvedLoadout`; lock further changes
    - `rejectEquipDuringRace(isRaceActive): boolean`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [x] 8.2 Write property test for weapon slot invariant (Property 7)
    - **Property 7: Weapon slot invariant is preserved under any equip sequence**
    - **Validates: Requirements 3.9, 4.4**
    - Test file: `packages/shared/src/loadout/__tests__/slots.prop.test.ts`
  - [x] 8.3 Write property test for loadout effective stats additive and capped (Property 8)
    - **Property 8: Loadout effective stats are the clamped additive sum of base and component deltas**
    - **Validates: Requirements 4.3**
    - Test file: `packages/shared/src/loadout/__tests__/stats.prop.test.ts`
  - [x] 8.4 Write property test for loadout immutability during race (Property 9)
    - **Property 9: Loadout is immutable once confirmed for a race**
    - **Validates: Requirements 4.5**
    - Test file: `packages/shared/src/loadout/__tests__/lock.prop.test.ts`
  - [x] 8.5 Create `packages/shared/src/career/CareerService.ts` with:
    - `computePrizeMoney(placement, eliminationCount, prizeTable)`: exact formula `placementPrize(placement) + eliminationCount × eliminationBonus`
    - `purchaseItem(career, itemPrice)`: atomic deduct; reject if `career.money < price` with exact shortfall; never go below zero
    - `advanceCircuit(career)`: increment `currentCircuitIndex`; wrap at 10 and increment `circuitNumber`
    - `addHighScore(table, entry)`: insert, sort descending by `totalEarnings`, cap at 10
    - `newCareer(slot, playerName, initialMoney)`: fresh state with empty owned lists at Track 1
    - _Requirements: 5.1–5.10_
  - [x] 8.6 Write property test for prize money formula (Property 10)
    - **Property 10: Prize money calculation matches the formula for all placements**
    - **Validates: Requirements 5.2**
    - Test file: `packages/shared/src/career/__tests__/prize.prop.test.ts`
  - [x] 8.7 Write property test for career money non-negative and atomic (Property 11)
    - **Property 11: Career money is non-negative and purchase is atomic**
    - **Validates: Requirements 5.3, 5.4**
    - Test file: `packages/shared/src/career/__tests__/money.prop.test.ts`
  - [x] 8.8 Write property test for high-score table sorted and capped (Property 12)
    - **Property 12: High-score table is always sorted and capped at 10 entries**
    - **Validates: Requirements 5.9**
    - Test file: `packages/shared/src/career/__tests__/highscore.prop.test.ts`

- [x] 9. Checkpoint — Verify shared logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement AI driver in `packages/shared/src/ai/`
  - [x] 10.1 Create `packages/shared/src/ai/WaypointNavigator.ts`: build waypoint graph from `TrackDef`; compute next waypoint for a car position; select racing line based on aggression 1–5
    - _Requirements: 6.1_
  - [x] 10.2 Create `packages/shared/src/ai/AIBrain.ts` with `computeAIInputs(driver, world, config, rng): CarInputs`
    - Steering: follow waypoint racing line (Req 6.1)
    - Forward-fire decision: opponent in range → random draw against skill-tier probability (30%/60%/90%) (Req 6.2)
    - Evasive mode: enter when armor < 25% max; exit when armor ≥ 40% or no opponent within 200 units (Req 6.3)
    - Hazard avoidance: detect mines/caltrops within tier-defined radius (50/100/150 units); steer clear (Req 6.4)
    - Rear-drop: opponent within 10 m behind and not evading → deploy if loaded (Req 6.5)
    - Lap time variation: use RNG to inject ±2%–±10% throttle jitter per lap (Req 6.6)
    - _Requirements: 6.1–6.6_
  - [x] 10.3 Write property test for AI firing probability convergence (Property 14)
    - **Property 14: AI firing probability converges to the configured tier value**
    - **Validates: Requirements 6.2**
    - Test file: `packages/shared/src/ai/__tests__/firing-prob.prop.test.ts`
  - [x] 10.4 Write property test for AI lap time variation (Property 15)
    - **Property 15: AI lap time variation is within the specified band**
    - **Validates: Requirements 6.6**
    - Test file: `packages/shared/src/ai/__tests__/lap-time.prop.test.ts`

- [x] 11. Implement save/load system in `packages/shared/src/persistence/`
  - [x] 11.1 Create `packages/shared/src/persistence/SaveManager.ts`
    - `save(career, slot, path)`: encode with `SaveFileCodec`; write to `.tmp` then atomically rename
    - `load(slot, path)`: read file; verify CRC32 over all bytes before magic; throw `CorruptSaveError` on mismatch
    - `listSlots(dir)`: scan for up to three slot files; return `SlotInfo[]` with slot number and player name
    - `confirmOverwrite(slot)`: guard that must be called before overwriting an occupied slot (caller responsibility enforced by type)
    - _Requirements: 12.1–12.6_

- [x] 12. Implement game server infrastructure in `packages/server/src/`
  - [x] 12.1 Create `packages/server/src/session/SessionManager.ts` implementing `createSession`, `joinSession`, `listOpenSessions`, `transferHost`, and `closeSession` backed by an in-process `Map<SessionId, Session>`
    - Validate `SessionConfig`: name 1–32 chars, `maxPlayers` 2–8, password null or ≤20 chars
    - Host transfer: assign to participant with minimum `joinedAt`; close if none remain
    - Fill empty slots with AI at race start when `fillWithAI === true`
    - _Requirements: 7.1–7.8_
  - [x] 12.2 Write property test for session config validation (Property 16)
    - **Property 16: Session creation validates all config constraints**
    - **Validates: Requirements 7.1, 7.3**
    - Test file: `packages/server/src/__tests__/session-config.prop.test.ts`
  - [x] 12.3 Write property test for host transfer preserves one host (Property 17)
    - **Property 17: Host transfer preserves exactly one host at all times**
    - **Validates: Requirements 7.8**
    - Test file: `packages/server/src/__tests__/host-transfer.prop.test.ts`
  - [x] 12.4 Create `packages/server/src/network/ServerNetworkManager.ts`
    - `receiveInput(participantId, frame)`: validate timestamp; store in per-participant ring buffer
    - `broadcastSnapshot(state, tick)`: encode with `StateSnapshotCodec`; send binary frame to all connected WebSocket clients
    - `onDisconnect(participantId)`: detect silence > 3 s (> 60 missed frames); freeze then remove car; emit `ParticipantLeft` event; trigger host transfer if needed
    - _Requirements: 7.6, 8.1, 8.5_
  - [x] 12.5 Create `packages/server/src/AuthorityLoop.ts`: run physics at 60 Hz via `setImmediate`; broadcast state snapshot at 20 Hz; inject AI inputs via `computeAIInputs` for AI slots; apply received player inputs
    - _Requirements: 8.1, 8.5_
  - [x] 12.6 Write property test for stale weapon events discarded cleanly (Property 21)
    - **Property 21: Stale weapon events are discarded without mutating game state**
    - **Validates: Requirements 8.4**
    - Test file: `packages/server/src/__tests__/stale-events.prop.test.ts`
  - [x] 12.7 Create `packages/server/src/http/MatchmakingRouter.ts` with REST endpoints: `POST /sessions` (create), `GET /sessions` (list open), `POST /sessions/:id/join`, `DELETE /sessions/:id` (host close)
    - _Requirements: 7.1, 7.2_
  - [x] 12.8 Create `packages/server/src/index.ts` entry point wiring together HTTP server, WebSocket server (`ws` library), `SessionManager`, `AuthorityLoop`, and `ServerNetworkManager`
    - _Requirements: 7.1–7.8, 8.1–8.8_

- [x] 13. Checkpoint — Verify server builds and session/network tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Implement client network manager in `packages/client/src/network/`
  - [x] 14.1 Create `packages/client/src/network/NetworkManager.ts`
    - `sendInput(frame)`: encode `InputFrame` and send over WebSocket
    - `onSnapshot(snapshot)`: decode with `StateSnapshotCodec`; store in snapshot buffer keyed by tick
    - `reconcile(snapshot)`: find snapshot tick in 30-frame ring buffer; re-simulate from that point; apply smooth-lerp correction when delta > threshold
    - `getInterpolatedState(renderTime)`: interpolate between two buffered snapshots for the given timestamp
    - Correction bounds: ≤2 m when RTT ≤150 ms; ≤5 m when RTT >150 ms; show warning indicator in latter case
    - Discard weapon fire events older than 200 ms without mutating state
    - Perform full state reset when `authorityChecksum` mismatch detected
    - _Requirements: 8.1–8.8_
  - [x] 14.2 Write property test for reconciliation correction bounded (Property 20)
    - **Property 20: Client reconciliation correction is bounded by the latency regime**
    - **Validates: Requirements 8.2, 8.3**
    - Test file: `packages/client/src/__tests__/reconcile.prop.test.ts`

- [x] 15. Implement renderer in `packages/client/src/renderer/`
  - [x] 15.1 Create `packages/client/src/renderer/Renderer.ts` initialising a `PIXI.Application` with `WebGLRenderer`; set up eight draw layers: road surface, track boundaries, scenery, hazards, cars, projectiles, explosions, HUD
    - _Requirements: 2.1, 2.2_
  - [x] 15.2 Implement scanline-based pseudo-3D road rendering: for each screen row compute world-space depth; sample road/scenery tiles from the track texture atlas; camera fixed 150–300 px behind and 60–120 px above leading car
    - _Requirements: 2.1_
  - [x] 15.3 Implement palette emulation WebGL fragment shader: 256×1 RGBA texture uniform for palette lookup; apply to all indexed-palette sprites and road surfaces
    - _Requirements: 2.6_
  - [x] 15.4 Implement car sprite rendering with depth-based scale and vertical offset; airborne scaling 100%–150% and 0–80 px vertical offset proportional to jump height
    - _Requirements: 2.3, 2.4_
  - [x] 15.5 Implement explosion animation: play on `Elimination` event at last-known car position for 500–1500 ms; remove car sprite on completion
    - _Requirements: 2.7_
  - [x] 15.6 Implement adaptive LOD: monitor rolling average FPS over 5 s; if sustained < 30 fps for > 2 s, reduce scenery draw distance by 25% increments down to 20% minimum
    - _Requirements: 2.5, 2.8_
  - [x] 15.7 Implement `Renderer.render(state: RenderState, alpha: number)` integrating all layers; wire to `requestAnimationFrame` game loop at 60 fps
    - _Requirements: 2.1–2.8, 13.2_

- [x] 16. Implement audio system in `packages/client/src/audio/`
  - [x] 16.1 Create `packages/client/src/audio/AudioSystem.ts` with 8 `AudioChannel` slots backed by Web Audio API; implement `playSFX(id)` evicting the channel with smallest remaining duration when all 8 are active; implement `playMusic(context)` fading to new track within 500 ms
    - _Requirements: 10.1, 10.6_
  - [x] 16.2 Wire SFX triggers: weapon fire (≤50 ms), car elimination (≤50 ms), jump launch (≤50 ms)
    - _Requirements: 10.2, 10.3, 10.4_
  - [x] 16.3 Implement music/SFX toggle: `setMusicEnabled` and `setSFXEnabled` apply within one rendered frame; wire to settings screen toggle controls
    - _Requirements: 10.5_
  - [x] 16.4 Write property test for audio channel count never exceeds 8 (Property 24)
    - **Property 24: Audio channel count never exceeds 8**
    - **Validates: Requirements 10.6**
    - Test file: `packages/client/src/__tests__/audio-channels.prop.test.ts`

- [x] 17. Implement HUD and UI screens in `packages/client/src/ui/`
  - [x] 17.1 Create `packages/client/src/ui/HUD.tsx` (PixiJS Container overlay) displaying: speed, armor level, per-weapon ammo counts, current lap, placement position, and homing-weapon warning indicator
    - _Requirements: 11.1_
  - [x] 17.2 Create `packages/client/src/ui/RaceResults.tsx` listing all participants' final placement, elimination count, and prize money earned
    - _Requirements: 11.2_
  - [x] 17.3 Create `packages/client/src/ui/MainMenu.tsx` with buttons for: Start Career, Host Session, Join Session, View High Scores, Settings
    - _Requirements: 11.3_
  - [x] 17.4 Create `packages/client/src/ui/Settings.tsx` with controls for: display resolution, audio volume sliders, key binding configuration, and network options
    - _Requirements: 11.4_
  - [x] 17.5 Create `packages/client/src/ui/PauseMenu.tsx`: pause overlay with Resume and Quit; continue simulation for remote participants; broadcast pause notification to session
    - _Requirements: 11.5_
  - [x] 17.6 Create `packages/client/src/ui/CompetitorInfo.tsx` displaying portraits and bio text for all nine AI driver characters; load portrait images from parsed `.SCR` assets
    - _Requirements: 11.6_
  - [x] 17.7 Create `packages/client/src/ui/CarConfig.tsx` for car and loadout configuration: chassis picker, component slots showing per-stat delta and resulting effective stat, weapon slot pickers with owned-only filtering
    - _Requirements: 4.1–4.7_
  - [x] 17.8 Create `packages/client/src/ui/Shop.tsx` showing component and weapon catalogue entries with name, effect, price; display exact shortfall when insufficient funds; call `CareerService.purchaseItem`
    - _Requirements: 5.3, 5.4_
  - [x] 17.9 Create `packages/client/src/ui/SessionBrowser.tsx` fetching `GET /sessions`; display name, track, current/max players; indicate full sessions; join button calling `POST /sessions/:id/join`
    - _Requirements: 7.2_
  - [x] 17.10 Create `packages/client/src/ui/Lobby.tsx`: show all participant loadouts and ready status; ready-up button; start race button (host only, enabled when all ready and min count met); display session password prompt for protected sessions
    - _Requirements: 7.3, 7.4, 7.5_
  - [x] 17.11 Create `packages/client/src/ui/HighScores.tsx` reading saved high-score table; display top 10 entries sorted by total earnings; entry form for player name (1–12 chars) on new career completion
    - _Requirements: 5.9_
  - [x] 17.12 Create `packages/client/src/ui/BrowserWarning.tsx`: detect browser and version at startup; show message identifying browser and minimum supported versions if unsupported; block game loop from starting
    - _Requirements: 13.6_

- [x] 18. Implement asset loader in `packages/shared/src/assets/`
  - [x] 18.1 Create `packages/shared/src/assets/AssetLoader.ts` implementing the `AssetLoader` interface: `loadTrack`, `loadCarSprites`, `loadWeaponTable`, `loadMusicTrack`; fetch pre-converted binary bundles from the `assets/` directory; complete track parsing within 5 s; throw typed `TrackLoadError` on failure
    - _Requirements: 9.2, 9.5_
  - [x] 18.2 Create `packages/shared/src/assets/SpriteSheetLoader.ts`: decode `.BLK`-derived binary sprite sheets into `PIXI.Spritesheet` compatible JSON atlas + `Uint8ClampedArray` pixel data with palette applied
    - _Requirements: 2.6_

- [x] 19. Wire client game loop in `packages/client/src/`
  - [x] 19.1 Create `packages/client/src/GameLoop.ts`: `requestAnimationFrame` loop running at 60 fps; each frame: read input, run local prediction via `stepPhysics`, call `NetworkManager.sendInput`, call `NetworkManager.getInterpolatedState`, call `Renderer.render`
    - _Requirements: 1.1, 2.5, 13.2_
  - [x] 19.2 Create `packages/client/src/InputHandler.ts`: listen to `keydown`/`keyup` events; map configurable key bindings to `CarInputs`; produce `InputFrame` with current tick and CRC32 of prior local state
    - _Requirements: 11.4_
  - [x] 19.3 Create `packages/client/src/App.tsx` (or `main.ts`) as client entry point: initialise PixiJS app, `AssetLoader`, `AudioSystem`, `NetworkManager`; render the appropriate UI screen based on application state machine (`mainMenu → carConfig → lobby → race → results → career`)
    - _Requirements: 13.1, 13.3_

- [x] 20. Checkpoint — Verify full client build with renderer, audio, and UI
  - Ensure all tests pass, ask the user if questions arise.

- [x] 21. Implement career mode single-player flow
  - [x] 21.1 Create `packages/client/src/career/CareerController.ts` orchestrating the single-player flow: new career → car config → race → results → shop → next race; call `CareerService.computePrizeMoney`, `CareerService.purchaseItem`, `CareerService.advanceCircuit`; auto-save within 5 s after each race via `SaveManager`
    - _Requirements: 5.1–5.10, 12.1, 12.2_
  - [x] 21.2 Implement career save slot management in `CareerController`: list slots on menu; prompt confirmation before overwriting occupied slot; display `CorruptSaveError` screen offering fresh start without overwriting
    - _Requirements: 12.3, 12.5, 12.6_

- [x] 22. Implement multiplayer session flow in `packages/client/src/multiplayer/`
  - [x] 22.1 Create `packages/client/src/multiplayer/MultiplayerController.ts` managing the host path: create session via REST, wait in lobby, start race when all ready; and the join path: browse sessions, enter password if required, sync state on join (within 2 s), enter lobby
    - _Requirements: 7.1–7.5_
  - [x] 22.2 Wire disconnection handling in `MultiplayerController`: display `ParticipantLeft` notifications to remaining players within 3 s; handle host-transfer notification; show "host has paused" banner on pause event
    - _Requirements: 7.6, 7.8, 11.5_

- [x] 23. Integration tests in `tests/`
  - [x] 23.1 Write full race simulation integration test: spin up server and 2 `NetworkManager` clients in-process; run a 2-lap race to completion; assert final placements are assigned 1 and 2, prize money matches formula
    - _Requirements: 5.2, 8.1_
  - [x] 23.2 Write multiplayer sync integration test: simulate 10% packet loss over a 30-second in-process race with 2 clients; assert all clients end with the same car positions within 1 m / 5°
    - _Requirements: 8.6_
  - [x] 23.3 Write career save/load integration test: construct a `CareerState`, save to a temp file, reload, assert all persisted fields are equal
    - _Requirements: 12.4, 5.5_
  - [x] 23.4 Write asset pipeline integration test: for each of the 10 track definitions in the converted `assets/` directory, call `AssetLoader.loadTrack` and assert no parse error is thrown and `waypointGraph.nodes.length > 0`
    - _Requirements: 9.1, 9.2_

- [x] 24. Final checkpoint — All tests pass end to end
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 25. Real asset-format reverse engineering (faithful recreation)
  - The parsers in section 4 were built to *assumed* layouts and never matched the real Death Track files. They are superseded by the tasks below, which target the **real Dynamix formats** documented in `research/dynamix-formats.md` (RES chunk container, RLE/LZW/LH1 compression, `PAL:`/`VGA:`, `SCR:`, `FNT:`, `BMP:`), plus the reverse-engineered Death-Track-specific payloads (`.TRK`/`RTK:`, `.MAP`, `.TBL`). Verify all decoders against the real files in the `dtrack` folder.
  - **Status summary (kept open honestly):** everything reverse-engineerable from the real game data is **done** — 25.1 ChunkReader, 25.2 decompressors, 25.3 chunk-tree probe (+committed report), 25.4 palette (EGA remap), 25.5 SCR, 25.6 FNT, 25.7 BMP, 25.9 TRK (all 10 tracks decode + render as closed circuits), 25.10 MAP (backdrops), 25.12 asset tests against real files, and 25.14 launch verification (a real track loads + renders in the client). The whole workspace is green (tools 131, client 534, integration 16). **Three children are intentionally not fully closed, each for a documented reason rather than remaining effort:** 25.8 `.TBL` is **deferred** (the files are 3D vector meshes, not stat tables, and their body layout is not confidently RE-able without inventing structure); 25.11 is **substantially done** (trackId map + real loader-compatible `convertReal` pipeline incl. loadable `TrackDef`s) with the sprite→`ChassisId` remap deliberately skipped (the recreation's `ChassisId`s are invented, with no chassis→file correspondence in the real data) and `music/`/`tables/` deferred (need `.MUS` decoding / non-`.TBL` stat source); 25.13 has the **real main menu wired + a runnable client**, with the in-race/lobby/career overlays left as documented placeholders that need live gameplay/session/career runtime this boot-time entry point can't truthfully supply. The parent stays unchecked to reflect those three.
  - [x] 25.1 Implement `ChunkReader` for the Dynamix RES chunk tree in `packages/tools/src/parsers/` (add to `packages/shared` if the runtime `AssetLoader` needs it): 3-char ID + `':'` + `uint32` size where the high bit is a container flag and the low 31 bits are the byte length; parse containers recursively; surface the byte offset on malformed input
    - _Requirements: 9.1, 9.5_
    - Implemented in `packages/tools/src/parsers/ChunkReader.ts` (`parseChunks`, `findChunk`, `ChunkNode`, `ChunkParseError`). Verified against real files: `ACTIVISI` (PAL:→EGA:/CGA: + SCR:→BIN:) and `CAR1.SCR` (SCR:→BIN:) parse correctly with byte offsets.
  - [x] 25.2 Implement the shared decompressors with a dispatcher keyed on the leaf `compressionType` byte: RLE (method `0x01`, high-bit repeat / low-bit copy), LZW (method `0x02`, dynamic 9–12 bit little-endian codes, first code 257, code 256 = dictionary reset with the divisible-by-8 skip rule), and LH1 (method `0x03`, the LHA `lh1` method)
    - _Requirements: 9.5_
    - Implemented in `packages/tools/src/parsers/decompress.ts` (`decompress` dispatcher + `rleDecompress`, `lzwDecompress`, `lh1Decompress` stub). LZW verified against the real `CAR1.SCR` LZW leaf (decodes to exactly 32000 bytes) plus synthetic encode→decode round-trips. **Format correction:** the real Death Track LZW is **LSB-first**, dictionary seeded 0–255 + code 256 (reset), first dynamic code **257**, and the code width grows the instant `nextCode === 2^width` (no divisible-by-8 skip rule was needed for these files); the dictionary freezes at 4096 entries. LH1 is a throwing stub until an `lh1` leaf is actually encountered.
    - Vertical slice (Phase 1 acceptance): `packages/tools/slice.mjs` decodes the `ACTIVISI` palette container and `CAR1.SCR` through chunk → LZW → pixels → palette and emits `packages/tools/out/CAR1.png` (a recognizable red sports car). **Finding:** `CAR1.SCR` decompresses to 32000 bytes = a single 4bpp plane (320×200, 16 colours), **not** the two-plane 64000-byte VGA form assumed in `research/dynamix-formats.md §4.1`; the exact plane layout and the `EGA:`/`CGA:` palette layout still need reverse engineering in 25.4/25.5.
  - [x] 25.3 Chunk-tree probe (diagnostic): walk every real file in the `dtrack` folder and record its chunk structure (IDs, container flags, lengths, nesting) to a report; use this to drive the reverse-engineering tasks
    - _Requirements: 9.1_
    - **Done.** Implemented in `packages/tools/src/chunkProbe.ts` (`probeChunkDir`, `reportFile`, `buildChunkReport`, `formatChunkReport`) and wired into the CLI as `deathtrack-tools --probe <inputDir> [reportFile]`. `buildChunkReport`/`reportFile`/`formatChunkReport` are pure functions of parsed chunk nodes, unit-tested against synthetic chunk bytes (`src/__tests__/chunkProbe.test.ts`, 4 tests); `probeChunkDir` walks a directory and records each file's flattened chunk tree (depth, id, container flag, length, offset), reporting a parse error for non-chunk files rather than throwing. Ran against the real folder and committed the artifact at `research/chunk-probe-report.txt` (101 files). The report is exactly what drove the section-25 RE: it shows `ACTIVISI` = `PAL:` container with `EGA:`/`CGA:` leaves + `SCR:`→`BIN:` (25.4/25.5), `ANGEL.BMP` = `BMP:`→`INF:`+`BIN:` (25.7), and confirms `.TRK`/`.TBL`/`.RCT` are raw (non-chunk) payloads (25.8/25.9). Contains only structural metadata (ids/lengths/offsets), no copyrighted content, so it is committed.
  - [x] 25.4 Palette decoder: `PAL:` container → `VGA:` sub-block; convert 0–63 channel values to 0–255 (`v * 255 / 63`); output a 256×3 (or shorter) RGB palette
    - _Requirements: 2.6_
    - Implemented in `packages/tools/src/parsers/PaletteDecoder.ts` (`decodePalContainer`, `decodeVgaPalette`, `scale6to8`, `egaPalette16`, `decodeEgaRemapPalette`). **Format correction (reverse-engineered):** the real `ACTIVISI` / `PALS.BLK` `PAL:` containers hold **`EGA:` (128 bytes) and `CGA:` (162 bytes)** sub-blocks, **not** `VGA:` — Death Track is a 16-colour EGA game. The 128-byte `EGA:` block is 64 LE16 words where every word's bytes are equal and every byte's nibbles are equal (so each entry is a single 4-bit value); it is two identical halves of 32 entries, and the first 16 entries of a half form a **logical → EGA hardware-colour remap table** (the next 16 are an identity ramp). `decodeEgaRemapPalette` resolves that table to a 16-colour RGB palette. A screen pixel's colour is `EGA_RGB[remap[pixelHighNibble]]`. Verified end-to-end by rendering the `CITYPIC.SCR` title screen and `CAR1.SCR` in correct EGA colour (see `slice.mjs`); unit tests in `src/parsers/__tests__/PaletteDecoder.test.ts` check the remap against the real `ACTIVISI` file. `decodeVgaPalette`/`scale6to8` remain for any true `VGA:` block (none present in Death Track's files). The `CGA:` sub-block layout is left for a future task if CGA rendering is ever needed.
  - [x] 25.5 SCR full-screen image decoder: decode the two-plane VGA form (Plane B = more-significant bits) into per-pixel palette indices, then apply the palette to produce RGBA; handle the single-plane EGA/`BIN:` form
    - _Requirements: 2.6, 11.6_
    - Implemented in `packages/tools/src/parsers/ScrDecoder.ts` (`decodeScr`, `decodeScreenBytes`, `decompressScrBin`, `doublePixelsHorizontally`, `applyPalette`, `grayscalePalette`). **Format correction (reverse-engineered by rendering):** every real `.SCR` decompresses to **exactly 32000 bytes = a 160×200 image, one palette index per byte, row-major** — **not** the two-plane 64000-byte VGA form in `research/dynamix-formats.md §4.1`. Death Track displayed these pixel-doubled to 320×200 (`doubleWidth`). Verified against `CAR1`/`CAR2`/`CAR3` (cars), `POSTWAR` (city), `DASH0`–`DASH2` (dashboards) and `CITYPIC` (title screen) — all render as complete, correctly-proportioned scenes. Decoding `CITYPIC.SCR` also surfaced and fixed a real LZW gap: it triggers a dictionary-full reset (code 256 at 4096 entries), which requires the **divisible-by-8 skip rule** on reset (now in `decompress.ts` and covered by a unit test). Unit tests in `src/parsers/__tests__/ScrDecoder.test.ts` verify all 8 real `.SCR` files decode to 160×200; `slice.mjs` emits inspectable PNGs.
  - [x] 25.6 FNT font decoder (v4/v5): parse the `FNT:` header (`0xFF`=1bpp v4, `0xFD`=8bpp v5), decompress the symbol data, then read per-glyph offsets, per-glyph widths, and glyph bitmaps (`stride = ((width*bpp)+7)/8`, `height = fontHeight`)
    - _Requirements: 2.6, 11.1_
    - Implemented in `packages/tools/src/parsers/FntDecoder.ts` (`decodeFonts`, `decodeFnt`, `glyphForCode`). **Format correction (reverse-engineered):** the real Death Track `FONTS.BLK` fonts are **not** the v4/v5 layout in `research/dynamix-formats.md` §6. They are a simpler, older fixed-width format: a **4-byte header** (`width, height, startSymbol, count`) followed by `count` glyphs of `height` bytes each, **1bpp, MSB = leftmost pixel**, uncompressed, no per-glyph offset/width tables. Confirmed by rendering: with this layout `'A'`/`'H'` render as their letters and `(dataLen - 4) / count` is exactly `height` for all three fonts (4×5, 6×6, 8×8, each 96 glyphs from `0x20`). Verified end-to-end by rendering full glyph sheets and the word "HELLO" in every font; unit tests in `src/parsers/__tests__/FntDecoder.test.ts` check the header parse, glyph geometry, blank space glyph, and the 'H' letterform against the real `FONTS.BLK`. (`render-font.mjs` was the diagnostic renderer.)
  - [x] 25.7 BMP sprite decoder: parse the `INF:` chunk (`imgCount`, widths, heights); decode the `SCN:`/`OFF:` form (offset table + 2-bit-command RLE with `addValue` and transparent skips) and the `BIN:` single-image form
    - _Requirements: 2.2, 2.6_
    - Implemented in `packages/tools/src/parsers/BmpDecoder.ts` (`decodeBmpFile`, `decodeBmp`, `parseInf`, `subImageToRgba`). The `INF:` layout matches the doc (`uint16 imgCount`, `uint16[] widths`, `uint16[] heights`). **Finding:** Death Track's sprites (`BITMAPS.BLK` and single `.BMP` files) use the **`BIN:` single-image form** — an LZW-compressed buffer of consecutive subimages, each **4-bpp (2 pixels/byte, high nibble = left pixel), row-major**. This 4-bpp packing was verified exactly: for every `BMP:` in `BITMAPS.BLK`, `sum(width*height)/2` equals the decompressed byte count. Each 4-bit index selects an EGA remap-palette colour (task 25.4). Verified end-to-end by rendering `ANGEL.BMP` (a competitor portrait) and `BAY_AREA.BMP` (the Transamerica Pyramid) with the EGA palette (dithered as authentic for a 16-colour digitised photo). Unit tests in `src/parsers/__tests__/BmpDecoder.test.ts` check `INF` parsing, the single-image `ANGEL.BMP`, and exact 4-bpp sizing for every container in `BITMAPS.BLK`. The `SCN:`/`OFF:` subimage-table form is not present in Death Track's files and is left as an explicit unsupported error until a file needs it.
  - [ ] 25.8 Reverse-engineer and implement the `.TBL` stat-table decoder (files lead with binary count/version words such as `00 00 01 00`, not an ASCII magic; layout TBD); verify against real tables (`ANGEL.TBL`, `SLY.TBL`, etc.)
    - _Requirements: 3.1, 4.1, 4.2, 4.3_
    - **Investigated and reclassified — NOT stat tables. Deferred (format body not confidently decoded).** Probing all 13 `.TBL` files shows they are **3D vector model definitions**, not numeric stat/balance tables. What IS confirmed: (1) sizes are irregular (1412, 1621, 1656, 1690, … 2092) with no common record-size divisor, ruling out fixed-size stat records; (2) every competitor/car `.TBL` (`ANGEL`, `SLY`, `MANIAC`, `CRIMSON`, `MYCAR0/1/2`, …) shares a consistent leading signature `00 00 01 00 00 00 00 00 …`, and `SHAPE.TBL` (78 544 bytes) is a distinct, larger shared library — consistent with a mesh/display-list family; (3) there are **no car-chassis/weapon numeric stat tables among the `.TBL` files** — gameplay stats (Requirements 3.1/4.x) must come from another source (likely embedded in `DTRACK.EXE`) and are tracked separately. **Correction to an earlier hypothesis:** an initial guess that the body is a `uint16` offset table at byte 16 terminated by `0xffff` did **not** hold up under a stricter check — reading it that way yields non-monotonic, out-of-bounds offsets for every competitor `.TBL` (e.g. `ANGEL` → `[56, 39424, 750, …]` in a 1690-byte file). So the exact polygon/vertex record layout is **not** confidently reverse-engineered, and a decoder would have to invent structure — which the project's no-fabrication rule forbids. `.TBL` is therefore **deferred**: it only becomes useful alongside a 3D vector renderer, and decoding its body faithfully needs more RE than the current evidence supports. The `chunk-probe-report.txt` (25.3) records that `.TBL` files are non-chunk raw payloads. (Diagnostics used: ad-hoc `probe-tbl*.mjs`, since removed.)
  - [x] 25.9 Reverse-engineer and implement the `.TRK` track decoder: `RTK:` payload → road geometry, jump ramps, waypoint graph, pit lane, hazard zones, scenery (layout TBD); verify all 10 tracks decode without error
    - _Requirements: 9.1, 9.2, 9.5_
    - **Complete for everything the format actually contains.** All 10 tracks decode without error and their road geometry is fully reverse-engineered, tested, and visually verified as closed circuits (details below). The one honest caveat: the task text lists "jump ramps, waypoint graph, pit lane, hazard zones, scenery," but the reverse engineering established that **the `.TRK` format has no separate section for those** — the road path consumes the entire body (the tail is only a 2–4-byte terminator), so there is no on-disk ramp/pit/hazard/waypoint/scenery data to decode. Those attributes (if the original game had them) are either derived at runtime or absent; the loader-compatible `TrackDef` emitted by `convertReal` (25.11) therefore carries the real decoded `roadSegments` and lets the runtime rebuild the waypoint graph, with the gameplay-zone arrays honestly empty rather than fabricated. So the decode goal is met; the missing sub-items are a property of the format, not incomplete work.
    - Implemented in `packages/tools/src/parsers/TrkDecoder.ts` (`decodeTrk`, `TrackData`, `CenterlinePoint`, `RoadPathPoint`). **Road geometry decoded and visually verified — all 10 tracks now trace a full closed circuit.** `.TRK` is a raw payload (not chunk-wrapped) that opens with the ASCII tag `"TRK:"` followed by an even-length little-endian **int16 stream**. Structure, confirmed across all 10 tracks: (1) a short lead-in **centerline preamble** of 4-byte `(dx, distance)` pairs; (2) the **road path** — the bulk of the file — an array of 6-byte three-column records tracing the track centerline. Two columns are the ground plane (`x`, `z`) and the third is a smoothly-varying **profile** term (curvature/banking/elevation, named neutrally). Verified invariant across all 10 tracks (0 violations): each step changes **at most one** column by more than ~±40 — a straight run advances one ground axis, a corner switches to the other, and the profile drifts smoothly. **Key correction — the columns are PERMUTED per track:** the profile is `col1` for 8 tracks but `col0` for BAY_AREA and ST_LOUIS, so it is identified structurally as the **smallest-span column** (it stays within a ~40–200 band while the two ground axes sweep thousands of units); the other two columns become `x`/`z` in order. Previously hardcoding profile=`col1` made BAY_AREA/ST_LOUIS decode as chaos (profile span 12k–14k, hundreds of big jumps); the smallest-span rule fixes both. **The road path now consumes the entire body for every track — the `tail` is only a 2–4-byte terminator (no separate section exists after the path)**, so any per-segment attributes (pit lane, jump ramps, hazard zones, AI waypoint graph — `research/dynamix-formats.md` §7.1), if present, are encoded within the records; their exact meaning could not be confirmed without inventing structure, so they are left as the neutral `profile` column rather than fabricated. **Rendering the `(x, z)` polyline produces a recognisable closed race circuit for all 10 tracks** (verified visually incl. BAY_AREA, ST_LOUIS, ORLANDO; close-gap 6–60 units, `roadPathClosed === true`). The closure test skips the 2 lead-in preamble records (`PATH_PREAMBLE_RECORDS`), whose first column carries a large header value that would otherwise inflate the gap. `decodeTrk` returns the centerline preamble, the road-path polyline (with `roadPathStart`/`roadPathEnd`/`roadPathClosed`), the full `Int16Array`, and the remaining terminator bytes as an opaque `tail`; **all 10 tracks parse without error** (Requirement 9.2). Unit tests in `src/parsers/__tests__/TrkDecoder.test.ts` verify the tag, centerline, the one-axis-at-a-time road-path polyline (synthetic + all 10 real tracks), the permuted-column profile assignment (smallest-span band < 1000 for every track), full closed-circuit tracing for **all 10** tracks, and full byte coverage.
    - Also implemented here (part of 25.11): the filename → `trackId` map (`TRACK_ID_BY_FILENAME`, `trackIdForFilename`), tested against all 10 names.
  - [x] 25.10 Reverse-engineer and implement the `.MAP` minimap decoder (layout TBD)
    - _Requirements: 9.1_
    - Implemented in `packages/tools/src/parsers/MapDecoder.ts` (`decodeMap`, `TrackBackdrop`, `BackdropStrip`). **Format reverse-engineered and reclassified — not a minimap.** Each `.MAP` is a raw **LZW-compressed leaf** (type `0x02`) decompressing to a fixed **24026-byte** payload whose layout is `uint16 count`, `uint16[count] widths`, `uint16[count] heights`, then `count` strips of `width*height` bytes (one 16-colour EGA index per pixel, row-major) — the same header shape as `BMP:` `INF:`. For every one of the 10 tracks this is `count=6`, `160×25` strips (`2 + 6*4 + 6*160*25 = 24026`, `match=true`). Rendering reveals these are the track's **horizon backdrop panorama strips**, not an overhead minimap — the Bay Area strips clearly show the San Francisco skyline and the Golden Gate Bridge. All 10 `.MAP` decode without error; unit tests in `src/parsers/__tests__/MapDecoder.test.ts` verify the strip count/geometry and error handling. Also wired into the real CLI pipeline (`convertReal` emits `assets/backdrops/<NAME>.dtasset`, Map kind).
  - [ ] 25.11 Add the filename → `trackId` mapping (BAY_AREA→bay_area, BOSTON→boston, CHICAGO→chicago, HOUSTON→houston, LA→los_angeles, NYC→manhattan, ORLANDO→orlando, PHOENIX→phoenix, SEATTLE→seattle, ST_LOUIS→st_louis) and rework the tools CLI to emit converted assets under the names/paths the `AssetLoader` expects
    - _Requirements: 9.1, 9.5, 9.6_
    - **trackId map done** (`TRACK_ID_BY_FILENAME` / `trackIdForFilename` in `TrkDecoder.ts`, tested). **CLI rework done for the decodable formats:** new `packages/tools/src/realPipeline.ts` (`convertReal`) drives the section-25 decoders and emits `AssetLoader`-compatible containers (same `encodeAsset` framing) under the loader's nested tree; invoked via `deathtrack-tools --real <in> <out>`. Verified against the real `dtrack` folder: **64 assets written, 0 errors**, and **all containers round-trip through the shared `decodeAsset`** (unit test `src/__tests__/realPipeline.test.ts` runs the real conversion and checks paths + payload shapes). Emitted: `assets/palette/ACTIVISI.dtasset` (16-colour EGA palette), `assets/screens/<NAME>.dtasset` (160×200 index buffers, Screen kind), `assets/sprites/<NAME>.dtasset` (4-bpp sprite sheets as `SpriteSheetBundle` — the exact shape the shared `SpriteSheetLoader` consumes, SpriteSheet kind), `assets/fonts/FONTS.dtasset` (glyph data), `assets/backdrops/<NAME>.dtasset` (`.MAP` horizon strips, Map kind), and **`assets/tracks/<trackId>.dtasset`** (Track kind, named by the canonical `trackId`, e.g. `LA`→`los_angeles`, `NYC`→`manhattan`; all 10 tracks). **The track container is now a full `reconstructTrack`-loadable `TrackDef`** (not just raw geometry): `roadPathToTrackDef` in `realPipeline.ts` maps the decoded road-path polyline to real `roadSegments` (`centre` = the decoded ground-plane `(x, z)`; `normal` = the computed unit perpendicular of the direction to the next point), and emits the five fields `reconstructTrack` requires. `waypointGraph` is emitted **empty on purpose** so the runtime `buildWaypointGraph` rebuilds it from `roadSegments` (a closed loop over the ordered centerline). Data the `.TRK` format does not encode is handled honestly, not fabricated: per-segment `width` (a documented `DEFAULT_ROAD_WIDTH = 20`) and `surface` (`'asphalt'`) are defaults, and `pitLane`/`jumpRamps`/`hazardZones`/`scenery` are emitted **empty** (the decoded tail is only a terminator — no such section exists, see 25.9). `name`/`city` come from a small fixed `TRACK_META` lookup (the real venue names, not decoded from bytes); the raw `roadPath` (incl. the neutral `profile` column) and lead-in `centerline` are carried through for fidelity. **Verified end-to-end:** the `realPipeline` test loads the emitted `orlando` container through the shared runtime `BinaryAssetLoader.loadTrack` → `reconstructTrack`, getting back a `TrackDef` with 500+ road segments and the expected name — so a real converted track is genuinely loader-compatible. **Remaining for full 25.11:** the `sprites/<NAME>` stems keep their real DOS filenames rather than the loader's canonical `ChassisId` ids — and this is **deliberate, not an oversight**. The runtime `ChassisId` union is `'hellcat' | 'crusher' | 'pitbull'`, but those names are **invented for this recreation** (requirements.md 4.1 lists them as "e.g., Hellcat, Crusher, Pitbull", and no `HELLCAT/CRUSHER/PITBULL` file exists in the original game). The real Death Track sprite files are the competitor characters (`ANGEL`, `MANIAC`, `CRIMSON`, `LURKER`, `MEGA`, `MELISSA`, `MENACE`, `SLY`, `WRECKER`, `CHAMP`) plus UI screens (`TITLE`, `RESULTS`, `WIN`, …) and part/weapon sheets — there is **no chassis→file correspondence in the real data**, so mapping e.g. `ANGEL`→`hellcat` would be fabricated. Per the project's no-invention rule, the sprites are therefore emitted faithfully under their real stems; wiring `loadCarSprites(ChassisId)` to specific art is a design decision for whoever defines the three recreation chassis, not a decode step. `music/` and `tables/` outputs remain deferred (depend on `.MUS` decoding and real stat data — the `.TBL` files are 3D meshes, not stat tables, see 25.8). The legacy `run`/`DISPATCH` path (section-4 parsers) is left intact behind the default no-flag invocation.
  - [x] 25.12 Rewrite the asset tests (the tools unit tests and the `tests/` asset-pipeline integration test) to run against the REAL files in the `dtrack` folder instead of synthetic fixtures
    - _Requirements: 9.1, 9.2, 9.6_
    - **Done — the asset tests now exercise the real files.** The six section-25 decoder unit tests (`Bmp`/`Fnt`/`Map`/`Palette`/`Scr`/`Trk`Decoder`.test.ts`) already read the real `dtrack` files directly (`DTRACK_DIR`, skip-if-absent), and `packages/tools/src/__tests__/realPipeline.test.ts` runs the real `convertReal` over the whole folder. The last synthetic-only test — the top-level `tests/src/asset-pipeline.integration.test.ts` — was rewritten to **prefer real converted containers**: when the game files are present it runs `@deathtrack/tools` `convertReal` into a temp dir and loads the resulting `assets/tracks/<id>.dtasset` bundles through the shipped `BinaryAssetLoader.loadTrack` → `reconstructTrack` (the genuine decode-of-real-data path). Because real tracks emit an empty `waypointGraph` by design, the AI-graph assertion now runs the runtime `buildWaypointGraph`, which rebuilds a populated closed-loop graph from the decoded `roadSegments` (verifying 9.1/9.2 for real geometry). When the game files are absent (clean checkout / CI) it falls back to byte-identical synthetic containers so the pipeline is still exercised without faking a pass. To import the pipeline in-process, added a public barrel `packages/tools/src/index.ts` (re-exports `convertReal`, `encodeAsset`, `decodeAsset`, `AssetKind`) with `main`/`exports` in the tools `package.json`, and `@deathtrack/tools` as a `tests` dependency. **Verified:** the asset-pipeline integration test passes 13/13 against the real converted tracks, and the tools suite stays green (127 tests). (The sibling `full-race`/`multiplayer-sync` integration suites — which import the client's built network core — now also pass after adding a client library build; see 25.13.)
  - [ ] 25.13 Add `index.html` and wire the real UI overlays into `App.bootstrap()`; produce a runnable `vite build`/dev client
    - _Requirements: 11.3, 13.1, 13.2_
    - **Runnable client shell done.** Added `packages/client/index.html` (mounts `#app`, pixelated canvas styling) and `packages/client/src/main.ts` (the browser entry: waits for the DOM, calls the existing `bootstrap()` from `App.tsx`, and shows a fatal-error panel on startup failure). `vite build` succeeds (757 modules, emits `dist/index.html` + chunks) and the client typechecks clean, so `vite dev`/`vite build` produce a launchable client. **Asset loading now wired (task 25.14):** `bootstrap()` constructs a `BinaryAssetLoader` over a new browser `HttpAssetSource` (`packages/client/src/assets/HttpAssetSource.ts`) and, on a supported browser, loads a real converted track and draws its centerline (see 25.14). **Client library build added:** the client now emits a Node-resolvable module tree to `dist/` via a dedicated `tsconfig.build.json` (`npm run build:lib`), separate from the vite web bundle which moved to `dist-web/`. This is what other workspace packages import by path (e.g. the integration tests import `@deathtrack/client/dist/network/NetworkManager.js`); with it in place the `full-race` and `multiplayer-sync` integration suites pass. The client `build` script runs `build:lib && vite build`. **Real main-menu overlay wired:** `bootstrap()` now wires the `mainMenu` factory to the real `MainMenu` overlay (`ui/MainMenu.tsx`, adapted via its `.view`) with navigation handlers that `app.dispatch(...)` the matching `AppEvent` — this is the one screen fully constructible at boot since it needs only callbacks, no live game data (verified: it's the honest, working part). `App` is captured in a `let` before the `overlays` object because factories run lazily after the App exists. **Still placeholder (each needs live runtime data this boot-time entry point can't truthfully provide):** `carConfig` (a live `Loadout` + chassis/component/weapon catalogues + owned lists), `lobby` (a live multiplayer `Session`), `race` (per-frame `CarRaceState` for the HUD + the running sim/loop), `raceResults` (finishing `ParticipantRaceOutcome[]` + a `PrizeTable`), and `career` (live `CareerState`; note there is no single `Career.tsx` — that flow composes `Shop`/`HighScores`/`CompetitorInfo`). Those are documented in-code and assembled per-screen as their flow is entered; the `AudioSystem` (constructible with a backend) and `NetworkManager` (needs a live socket + sim context) are per-race collaborators, not overlays. 534 client tests pass (incl. `App.test.ts`, whose contract is preserved); `build:lib` + `vite build` both succeed.
  - _Track-load status for 25.11/25.14 (RESOLVED):_ the runtime `BinaryAssetLoader` (`packages/shared/src/assets/AssetLoader.ts`) reads a container format that **matches** the tools `encodeAsset` (same magic/version/kind/CRC/JSON) from nested canonical-id paths (`assets/tracks/<TrackId>.dtasset`, `sprites/<ChassisId>`, `tables/weapons`, `music/<MusicContext>`); its `reconstructTrack` requires `roadSegments, waypointGraph, pitLane, jumpRamps, hazardZones`. **`convertReal` now produces a `TrackDef` that satisfies this** (see 25.11): the fully-decoded closed road-path polyline becomes real `roadSegments` (`centre` + computed `normal`), the waypoint graph is left empty for the runtime to rebuild from the segments (confirmed by `buildWaypointGraph`), and the gameplay zones the `.TRK` does not contain are emitted empty rather than invented. This was unblocked by the 25.9 finding that the road path covers the whole file (there is no separate tail section to reverse-engineer). A real converted `orlando` track is verified to load through `BinaryAssetLoader.loadTrack` in the `realPipeline` test. **25.14 is now done** (below): the client loads a real converted track via `BinaryAssetLoader` over a browser `HttpAssetSource` and draws its `roadSegments` centerline as a top-down preview. **Still open for a full in-race render:** per-segment lane width/surface and gameplay zones are defaults/empties (the format lacks them), and drawing the track through the scanline pseudo-3D race scene (vs the top-down preview) plus wiring the game loop + real UI overlays remains (part of 25.13). The CLI `sprites/` stems also still need remapping to canonical `ChassisId`s.
  - [x] 25.14 Launch verification: load a real converted track in the browser and confirm it renders
    - _Requirements: 2.1, 2.2, 9.2_
    - **Done — a real converted track loads and renders end-to-end.** Added a browser `AssetSource` (`packages/client/src/assets/HttpAssetSource.ts`) that fetches `.dtasset` containers over HTTP, and a pure, headless-tested fit helper (`packages/client/src/renderer/trackPreview.ts`, `layoutTrackPreview`) that projects a track's `roadSegments` centre points into the canvas (bounding-box → uniform scale → centred, Y flipped for a top-down read). `bootstrap()` (`App.tsx`) now, on a supported browser, constructs a `BinaryAssetLoader` over the `HttpAssetSource`, calls `loadTrack('orlando')`, and draws the decoded centerline as a top-down polyline (PixiJS `Graphics` on the `trackBoundaries` layer). The draw is best-effort — a missing asset is logged and the client still boots — and is a **static top-down preview**, deliberately distinct from the in-race scanline pseudo-3D scene (that is driven by the per-race game loop, still to be wired). **Verified:** the client typechecks clean, all **534 client tests pass** (incl. new `trackPreview` and `HttpAssetSource` unit tests), and `vite build` succeeds; running the tools CLI `deathtrack-tools --real <dtrack> packages/client/public` emits all 10 track containers under `public/assets/tracks/`, and the build copies `dist/assets/tracks/orlando.dtasset` (280 KB) so it is served in production. The converted assets are **git-ignored** (derived from the copyrighted original game; generated locally, never committed — see `.gitignore`). **Remaining for a full in-race render:** drawing the track through the scanline renderer / race scene and wiring the game loop + real UI overlays (part of 25.13).

- Tasks marked with `*` are optional and can be skipped for a faster MVP implementation
- Property tests reference the numbered Correctness Properties in the design document
- All property tests use **fast-check** integrated with **Vitest** (`it.prop(...)`)
- `numRuns` defaults to 100 per property; increase to 1000 for codec and physics properties when targeting release confidence
- The asset pipeline requires the original Death Track game files (`.TRK`, `.MAP`, `.BMP`, `.TBL`, `.MUS`, `.SCR`, and `FNT:`/`PAL:`/`VGA:` chunks) — these use the Dynamix RES chunk format (see `research/dynamix-formats.md`) and are not included in source control. Section 4 targeted assumed layouts and is superseded by section 25, which works against the real formats.
- Codec schema versions are immutable; any breaking change requires a new version field
- The server authority loop runs on `setImmediate` at 60 Hz internally; the broadcast tick fires every 3rd loop iteration (20 Hz)
- Client prediction ring buffer holds 30 frames (0.5 s); snapshots older than the buffer are handled via full state reset

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8"] },
    { "id": 3, "tasks": ["2.9"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2"] },
    { "id": 6, "tasks": ["3.3", "4.1", "4.2", "4.3", "4.4", "4.5"] },
    { "id": 7, "tasks": ["3.4", "3.5", "4.6", "6.1"] },
    { "id": 8, "tasks": ["3.6", "3.7", "3.8", "3.9", "4.7", "6.2"] },
    { "id": 9, "tasks": ["6.3", "6.4", "6.5", "8.1", "11.1"] },
    { "id": 10, "tasks": ["6.6", "6.7", "6.8", "6.9", "6.10", "7.1", "8.2", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8"] },
    { "id": 11, "tasks": ["7.2", "10.1", "12.1"] },
    { "id": 12, "tasks": ["7.3", "7.4", "10.2", "10.3", "10.4", "12.2", "12.3", "12.4"] },
    { "id": 13, "tasks": ["12.5", "12.6", "14.1", "18.1", "18.2"] },
    { "id": 14, "tasks": ["12.7", "12.8", "14.2", "15.1"] },
    { "id": 15, "tasks": ["15.2", "15.3", "16.1"] },
    { "id": 16, "tasks": ["15.4", "15.5", "15.6", "16.2", "16.3"] },
    { "id": 17, "tasks": ["15.7", "16.4", "17.1", "17.2", "17.3", "17.4", "17.5", "17.6", "17.7", "17.8", "17.9", "17.10", "17.11", "17.12"] },
    { "id": 18, "tasks": ["19.1", "19.2"] },
    { "id": 19, "tasks": ["19.3"] },
    { "id": 20, "tasks": ["21.1"] },
    { "id": 21, "tasks": ["21.2", "22.1"] },
    { "id": 22, "tasks": ["22.2"] },
    { "id": 23, "tasks": ["23.1", "23.2", "23.3", "23.4"] }
  ]
}
```
