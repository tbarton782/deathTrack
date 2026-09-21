# Requirements Document

## Introduction

This document specifies the requirements for a faithful modern recreation of the 1989 DOS game **Deathtrack** (Dynamix/Activision), extended with online multiplayer so players can race and battle friends over the internet. The game is a vehicular combat racing game set in a futuristic dystopian world where armed cars race across dangerous city tracks. The recreation preserves the original gameplay mechanics — car selection, weapon loadouts, career progression, and the distinctive top-down pseudo-3D racing — while adding a real-time online multiplayer mode and modern platform support (web browser and/or native desktop).

All named systems in this document are defined in the Glossary below.

---

## Glossary

- **Game**: The Deathtrack recreation application as a whole.
- **Player**: A human user participating in a race or session.
- **AI Driver**: A computer-controlled opponent character (e.g., Sly, Angel, Crimson, Lurker, Maniac, Melissa, Menace, Mega, Wrecker) that competes in single-player or hybrid sessions.
- **Car**: A vehicle with stats (top speed, acceleration, armor, handling) that a Player or AI Driver races with.
- **Track**: A city-based race course (Bay Area, Boston, Chicago, Houston, LA, Manhattan, Orlando, Phoenix, Seattle, St. Louis) with a defined layout, surface hazards, and jump placements.
- **Weapon**: An offensive or defensive item that a Car can carry and fire during a Race (e.g., missiles, lasers, mines, caltrops, terminators, beam cannons, machine guns, rams, wheel spikes).
- **Loadout**: The set of Weapons and equipment (engine, brakes, transmission, tires, airfoil, armor) configured on a Car before a Race.
- **Race**: A single timed combat-racing session on one Track with a defined set of Participants.
- **Participant**: A Player or AI Driver competing in a given Race.
- **Career**: A single-player persistent progression mode in which the Player earns money, purchases upgrades, and advances through increasingly difficult Races across all Tracks.
- **Circuit**: An ordered set of Races across multiple Tracks that forms one Career season.
- **Session**: A multiplayer lobby that groups Players for a Race or series of Races.
- **Host**: The Player who creates and configures a multiplayer Session.
- **Lobby**: The pre-Race screen in a Session where Players configure their Loadouts and confirm readiness.
- **Matchmaking Server**: The backend service that facilitates Session creation, discovery, and Player connection.
- **Elimination**: The state of a Participant whose Car is destroyed during a Race; an eliminated Participant cannot continue that Race.
- **Lap**: One full traversal of a Track's route.
- **Placement**: A Participant's finish position in a Race (1st through Nth).
- **Renderer**: The Game subsystem responsible for drawing the game world and UI to screen.
- **Physics Engine**: The Game subsystem responsible for Car movement, collision, and projectile simulation.
- **Network Manager**: The Game subsystem responsible for synchronising game state between Players in a multiplayer Session.
- **Audio System**: The Game subsystem responsible for playing music and sound effects.
- **Asset Loader**: The Game subsystem responsible for loading track data, car graphics, weapon tables, and UI resources.
- **Round-Trip**: A serialise-then-deserialise operation that must reproduce the original data (used for save/load and network packet integrity).

---

## Requirements

### Requirement 1: Core Racing and Physics

**User Story:** As a Player, I want cars to move and handle realistically according to their stats, so that car choice and driving skill meaningfully affect race outcomes.

#### Acceptance Criteria

1. THE Physics Engine SHALL simulate each Car's position, velocity, and heading at a fixed timestep of 60 updates per second.
2. WHEN a Car accelerates, THE Physics Engine SHALL increase the Car's speed at a rate proportional to the Car's acceleration stat, up to a maximum equal to the Car's configured top speed, and SHALL NOT increase the Car's speed beyond that maximum.
3. WHEN a Car brakes, THE Physics Engine SHALL decrease the Car's speed at a rate proportional to the Car's brake stat, and SHALL NOT reduce the Car's speed below zero.
4. WHEN a Car steers, THE Physics Engine SHALL change the Car's heading at a rate proportional to the Car's handling stat and, for speeds above 1 unit per second, inversely proportional to its current speed; IF the Car's speed is 1 unit per second or less, THEN THE Physics Engine SHALL apply the heading change rate as if the speed were 1 unit per second.
5. WHEN a Car leaves the defined Track surface, THE Physics Engine SHALL apply a traction penalty reducing the Car's effective handling by 50% and capping the Car's speed at 50% of its configured top speed for the duration of off-track contact.
6. WHEN two Cars collide and their relative velocity at the point of contact is greater than 0.5 units per second, THE Physics Engine SHALL apply impulse forces to both Cars based on their respective masses and relative velocities.
7. WHEN a Car reaches a jump ramp, THE Physics Engine SHALL apply a vertical launch velocity proportional to the ramp's configured angle and the Car's current speed, and SHALL apply gravitational deceleration to that vertical velocity each subsequent timestep until the Car returns to Track surface level.
8. WHEN a collision is detected between two Cars within a timestep, THE Physics Engine SHALL resolve that collision within the same timestep; IF multiple collisions involving the same Car are detected within a single timestep, THEN THE Physics Engine SHALL resolve them in order of decreasing relative velocity.
9. THE Physics Engine SHALL produce deterministic simulation outputs given identical initial states, input sequences, and random seeds across all Car stat configurations, enabling replay and network state validation.

---

### Requirement 2: Track Rendering

**User Story:** As a Player, I want the tracks to look and feel like the original Deathtrack, so that the visual experience captures the classic game's aesthetic.

#### Acceptance Criteria

1. THE Renderer SHALL display each Track using a pseudo-3D perspective projection with a fixed camera offset of 150–300 pixels behind and 60–120 pixels above the leading Participant's Car sprite origin.
2. THE Renderer SHALL render the road surface, track boundaries, hazards, and scenery objects defined in the Track's layout data, with each category rendered in the draw order: road surface first, then track boundaries, then scenery objects, then hazards.
3. WHEN a jump is in progress, THE Renderer SHALL scale the Car sprite between 100% and 150% of its base size and apply a vertical offset between 0 and 80 pixels proportional to the jump's current height value to convey airborne height.
4. WHEN a Participant's Car position falls within the camera's view frustum, THE Renderer SHALL display that Car sprite on-screen, rendering up to the maximum Participant count simultaneously.
5. THE Renderer SHALL render at a minimum of 30 frames per second on the target platform under full Participant load, measured as the average frame rate over any 5-second window during active race gameplay.
6. THE Renderer SHALL use a sprite-based visual style limited to a 256-colour indexed palette, or a modern approximation that maps all asset colours to the nearest entry in the original game's 256-colour palette.
7. WHEN a Car is Eliminated, THE Renderer SHALL display an explosion animation lasting between 500 ms and 1500 ms at the Car's last known position, then remove the Car sprite upon animation completion.
8. IF the Renderer fails to sustain 30 frames per second for more than 2 consecutive seconds, THEN THE Renderer SHALL reduce scenery object draw distance by 25% increments until the frame rate target is restored or the minimum draw distance of 20% of the default value is reached.

---

### Requirement 3: Weapon System

**User Story:** As a Player, I want to equip and fire weapons during races, so that I can attack opponents and defend myself as in the original game.

#### Acceptance Criteria

1. THE Weapon System SHALL support the following weapon categories: forward-firing projectiles (machine guns, lasers, beam cannons, missiles, terminators), rear-drop hazards (mines, caltrops, wheel spikes), and rams.
2. WHEN a Player activates a forward weapon, THE Weapon System SHALL spawn a projectile at the Car's front position with the velocity and damage profile defined in that weapon's configuration table entry, within 50 milliseconds of the activation input.
3. WHEN a rear-drop weapon is activated, THE Weapon System SHALL place a hazard object at the Car's current rear position on the Track surface within 50 milliseconds of the activation input, and the hazard SHALL remain active until triggered or the race ends.
4. WHEN a projectile or hazard contacts an opponent Car, THE Weapon System SHALL reduce that Car's armor by exactly the weapon's configured damage value within one simulation tick (≤ 50 milliseconds).
5. WHEN a Car's armor reaches zero or below, THE Weapon System SHALL trigger an Elimination event for that Car within one simulation tick (≤ 50 milliseconds) of the armor reaching zero.
6. WHEN a laser or beam weapon is active, THE Weapon System SHALL apply damage to the targeted Car at the configured damage rate (in hit points per second), deducted in discrete ticks of ≤ 50 milliseconds each, until the weapon is deactivated or its battery charge reaches zero.
7. THE Weapon System SHALL enforce per-weapon ammunition limits as defined in the Loadout configuration, where ammunition values are whole numbers in the range 0 to 999. WHEN ammunition for a weapon reaches zero, THE Weapon System SHALL prevent further firing of that weapon and indicate to the Player that the weapon is out of ammunition.
8. WHEN a mine or caltrop hazard is contacted by any Car (including the Car that placed it), THE Weapon System SHALL apply the hazard's configured damage to that Car and remove the hazard object from the Track.
9. THE Weapon System SHALL allow a Car to carry at most one weapon per weapon slot (forward weapon slot, rear weapon slot, side spikes slot, ram slot); IF a Player attempts to equip a second weapon in an already-occupied slot, THEN THE Weapon System SHALL reject the equip action and indicate which slot is occupied.
10. WHEN a projectile is fired, THE Weapon System SHALL validate the projectile's state by performing a round-trip encode-decode of the projectile packet and reject transmission of any packet whose decoded state differs from its pre-encoded state by any field value.

---

### Requirement 4: Car and Loadout Configuration

**User Story:** As a Player, I want to choose my car and configure my weapons and equipment before a race, so that I can tailor my strategy.

#### Acceptance Criteria

1. THE Game SHALL provide at least three selectable Car chassis (e.g., Hellcat, Crusher, Pitbull), each with independently defined base stat values for top-speed, acceleration, armor, and handling, where no two chassis share identical values across all four base stats.
2. THE Game SHALL allow each Car to be equipped with one engine, one transmission, one brake system, one set of tires, one airfoil, and one armor type, each selected from the available catalogue.
3. WHEN a component is equipped, THE Game SHALL recalculate the Car's effective stats by additively applying the component's modifier values to the chassis base stats, with each effective stat capped at the defined maximum value for that stat.
4. THE Game SHALL allow each Car to carry weapons in designated slots as defined by Requirement 3, Criterion 9.
5. WHEN a Player confirms a Loadout, THE Game SHALL persist the selected chassis, all equipped components, and all equipped weapons for the duration of the Race, and SHALL prevent any further modifications to the Loadout until the Race concludes.
6. IF a Player attempts to equip a component they have not purchased, THEN THE Game SHALL reject the selection and display an error message indicating that the component has not been purchased.
7. WHEN a Player previews a component, THE Game SHALL display both the per-stat delta and the resulting effective stat value for each of the four stats (top-speed, acceleration, armor, handling) that the component would produce if equipped.

---

### Requirement 5: Career Mode

**User Story:** As a Player, I want a single-player career mode with progression, so that I can experience the full Deathtrack campaign and unlock upgrades over time.

#### Acceptance Criteria

1. THE Game SHALL provide a Career Mode in which the Player competes in a Circuit of Races across all ten city Tracks, played in a fixed sequential order from Track 1 to Track 10.
2. WHEN the Player completes a Race, THE Game SHALL award prize money equal to the sum of a Placement prize and an Elimination bonus, where the Placement prize is determined by finishing position (1st through last place) and the Elimination bonus is a fixed amount per Elimination the Player caused during that Race.
3. THE Game SHALL provide a Shop where the Player can spend earned money to purchase components and weapons from the catalogue, with each catalogue item displaying its name, effect, and price in whole currency units.
4. WHEN the Player has insufficient funds to purchase an item, THE Game SHALL display a message indicating the exact shortfall amount in whole currency units and prevent the purchase from completing.
5. THE Game SHALL persist Career state — including current money balance, the list of owned components and weapons, and the index of the current Race within the current Circuit — to a save file, and restore that state exactly when the Player resumes the session.
6. WHEN the Player completes all ten Races in a Circuit, THE Game SHALL present a Circuit completion screen showing total earnings for that Circuit and offer the option to begin a new Circuit with increased opponent difficulty, or to return to the main menu.
7. THE Game SHALL include all nine named AI Driver characters (Sly, Angel, Crimson, Lurker, Maniac, Melissa, Menace, Mega, Wrecker) as opponents in Career Mode, each assigned fixed stat profiles for speed, armour, and weapon loadout that match the original Deathtrack game values, with all nine present in every Race.
8. IF the Player's Car is Eliminated in a Race, THEN THE Game SHALL immediately end that Race for the Player, assign a last-place Placement for that Race, award no Elimination bonus, and return the Player to the post-race results screen.
9. THE Game SHALL provide a high-score table that displays the top 10 Career results ranked by total earnings in descending order, where each entry records the player-entered name (1–12 characters) and total earnings, stored persistently between application launches.
10. WHEN the Player begins a new Career, THE Game SHALL start with a fixed initial money balance and an empty owned-components list, with the Circuit beginning at Track 1.

---

### Requirement 6: AI Driver Behaviour

**User Story:** As a Player, I want AI opponents to race and fight competently, so that single-player and hybrid races are challenging and fun.

#### Acceptance Criteria

1. THE AI Driver SHALL follow the Track path using waypoint navigation, selecting the racing line based on its configured aggression level (an integer from 1 to 5) and skill tier (Novice, Standard, or Expert).
2. WHEN an opponent Car is within the AI Driver's forward weapon's configured maximum range, THE AI Driver SHALL fire its forward weapon with a hit-probability factor of 30% for Novice, 60% for Standard, and 90% for Expert skill tiers.
3. WHEN the AI Driver's armor falls below 25% of its maximum value, THE AI Driver SHALL cease offensive weapon fire and perform evasive steering manoeuvres until its armor reaches 40% of its maximum value or no opponent Car is within 200 units.
4. WHEN a road hazard (mine or caltrop) is within the AI Driver's detection radius (50 units for Novice, 100 units for Standard, 150 units for Expert), THE AI Driver SHALL steer to avoid the hazard such that the AI Driver's Car does not make contact with it.
5. WHEN an opponent Car is within 10 metres directly behind the AI Driver and the AI Driver is not currently performing evasive manoeuvres, THE AI Driver SHALL deploy a rear-drop weapon if one is equipped and loaded.
6. THE AI Driver's lap times SHALL vary by at least ±2% and at most ±10% across repeated runs of the same Track at the same skill level, producing consistent but non-deterministic behaviour.

---

### Requirement 7: Online Multiplayer — Session Management

**User Story:** As a Player, I want to create or join an online multiplayer session with my friends, so that we can race and fight each other in real time.

#### Acceptance Criteria

1. THE Game SHALL allow a Player to act as Host and create a named Session (1–32 characters) with a configurable number of Player slots (2–8) and a selected Track.
2. THE Game SHALL allow other Players to discover and join open Sessions via a Session browser that lists available Sessions by name, Track, and current Player count; IF a Session is full, THEN THE Game SHALL indicate that the Session is full and prevent the Player from joining.
3. THE Game SHALL allow a Host to configure a Session with a password (up to 20 characters); WHEN a Player attempts to join a password-protected Session with an incorrect password, THE Game SHALL reject the join attempt and display a password-incorrect message.
4. WHEN all Players in a Lobby have confirmed their Loadout as ready, THE Host SHALL be able to start the Race; IF fewer than the minimum configured Player count are ready, THEN THE Game SHALL prevent the Race from starting.
5. WHEN a Player joins a Session, THE Matchmaking Server SHALL assign the Player a unique Participant slot and synchronise the full Session state (Track selection, all current Participant Loadouts, and ready status) to the joining Player within 2 seconds.
6. IF a Player's connection is lost during a Race, THEN THE Network Manager SHALL remove that Player's Car from the simulation and notify all remaining Participants of the disconnection within 3 seconds of the connection loss being detected.
7. THE Game SHALL support a hybrid Session configuration in which any Player slot not occupied by a human Player at Race start is filled by an AI Driver with a randomly selected skill tier.
8. WHEN the Host leaves a Session before Race start, THE Game SHALL transfer Host status to the connected Player with the longest session membership duration and preserve all current Session configuration; IF no other Player remains, THEN THE Game SHALL close the Session.

---

### Requirement 8: Online Multiplayer — Network Synchronisation

**User Story:** As a Player, I want the online race to be smooth and fair, so that lag and desyncs don't ruin the experience.

#### Acceptance Criteria

1. THE Network Manager SHALL synchronise each Car's position, velocity, heading, armor, and weapon state (active weapon, ammo count, reload status) to all Participants at a minimum of 20 updates per second.
2. WHILE network round-trip latency is at or below 150 ms, THE Network Manager SHALL apply client-side prediction and server reconciliation such that any position correction applied to the local Car does not exceed 2 metres in a single update cycle (50 ms).
3. IF network round-trip latency exceeds 150 ms for a Participant, THEN THE Network Manager SHALL notify that Participant with a warning indicator and continue reconciliation at a reduced correction rate, capping positional corrections to 5 metres per update cycle.
4. WHEN a weapon fire event is received from a remote Player, THE Network Manager SHALL apply the event using timestamp-based interpolation provided the event timestamp is no older than 200 ms relative to the current server time; IF the event timestamp is older than 200 ms, THEN THE Network Manager SHALL discard the event and record the miss without altering any Participant's simulation state.
5. THE Network Manager SHALL detect and resolve state divergence (desync) by broadcasting an authoritative state snapshot from the session authority at least once every 5 seconds.
6. IF a Participant's simulation diverges from the authoritative state by more than the configured divergence threshold (default: 1 metre positional error or 5° heading error; configurable in the range 0.1 m–10 m and 1°–45° respectively), THEN THE Network Manager SHALL correct the local simulation to match the authoritative state within one update cycle (50 ms).
7. THE Network Manager SHALL encode all game state packets using a schema such that decoding an encoded state object produces an object equal to the original on all synchronised fields (position, velocity, heading, armor, weapon state).
8. THE Network Manager SHALL compress game state packets to a maximum of 512 bytes per update per Participant to remain within typical broadband constraints.

---

### Requirement 9: Track Fidelity

**User Story:** As a Player, I want all ten original city tracks faithfully recreated, so that I can experience the same courses I remember from the original game.

#### Acceptance Criteria

1. THE Game SHALL include all ten city Tracks: Bay Area, Boston, Chicago, Houston, Los Angeles, Manhattan, Orlando, Phoenix, Seattle, and St. Louis.
2. WHEN loading a Track, THE Asset Loader SHALL parse the Track's layout data and produce a representation containing road geometry, jump ramp positions, pit lane entry and exit positions, hazard zones, and waypoint graph, completing parsing within 5 seconds of the load request.
3. THE Game SHALL position the pit lane entry and exit according to each Track's original layout.
4. WHEN a Player's Car enters the pit lane, THE Game SHALL restore that Car's armor to its maximum value and reload all weapons to their maximum configured ammunition, completing the restoration before the Car exits the pit lane.
5. IF a Track file fails to parse correctly, THEN THE Asset Loader SHALL log a descriptive error message identifying the Track name and the point of parse failure, and present an error screen to the Player without loading any partial Track data.
6. THE Asset Loader SHALL support a round-trip encode-decode of the Track data format such that loading a Track file and re-encoding the parsed representation produces a byte-for-byte equivalent of the original file for all well-formed Track files.

---

### Requirement 10: Audio

**User Story:** As a Player, I want authentic sound effects and music, so that the audio atmosphere matches the original game's feel.

#### Acceptance Criteria

1. THE Audio System SHALL play a dedicated configured music track for each of the following game screens: main menu, race, shop, and results screen; WHEN the active screen changes, THE Audio System SHALL transition to the corresponding music track within 500 ms.
2. WHEN a weapon is fired, THE Audio System SHALL play the weapon's configured firing sound effect within 50 ms of the fire event.
3. WHEN a Car is Eliminated, THE Audio System SHALL play an explosion sound effect within 50 ms of the Elimination event.
4. WHEN a Car becomes airborne at a jump ramp, THE Audio System SHALL play the launch sound effect within 50 ms of the jump event.
5. THE Audio System SHALL allow the Player to independently toggle music and sound effects on or off via the settings screen; WHEN either toggle is changed, THE Audio System SHALL apply the change within one rendered frame.
6. THE Audio System SHALL support up to 8 simultaneously active sound effect channels; WHEN 8 channels are active and a new sound effect is triggered, THE Audio System SHALL replace the oldest active channel without producing an audible click or dropout artefact.

---

### Requirement 11: User Interface and Heads-Up Display

**User Story:** As a Player, I want a clear HUD and menus, so that I can understand my race status and navigate the game without confusion.

#### Acceptance Criteria

1. THE Game SHALL display a HUD during a Race showing the Player's current speed, armor level, ammunition counts for each equipped weapon, current Lap, Placement, and a warning indicator when a homing weapon that has acquired the Player's Car as its target is detected.
2. WHEN a Race concludes, THE Game SHALL display a Race results screen listing all Participants' final Placement, Elimination count, and prize money earned.
3. THE Game SHALL provide a main menu with options to start Career Mode, host a multiplayer Session, join a multiplayer Session, view high scores, and access settings.
4. THE Game SHALL provide a settings screen allowing the Player to configure display resolution, audio volume, key bindings, and network options.
5. WHEN a Player pauses a Race, THE Game SHALL display a pause menu with options to resume or quit to the main menu; in multiplayer Sessions, the game simulation SHALL continue running and all other Participants SHALL receive a notification that the Player has paused.
6. THE Game SHALL display portraits and biographical text for all nine named AI Driver characters (Sly, Angel, Crimson, Lurker, Maniac, Melissa, Menace, Mega, Wrecker) in the Competitor Info screen accessible from the Career Mode menu.

---

### Requirement 12: Save and Load

**User Story:** As a Player, I want my Career progress saved automatically, so that I don't lose my progress between play sessions.

#### Acceptance Criteria

1. THE Game SHALL automatically save Career state within 5 seconds of every Race completion, without requiring any Player action.
2. THE Game SHALL allow the Player to manually save Career state from the Career menu at any time outside of a Race.
3. WHEN the Game loads a saved Career file, THE Asset Loader SHALL validate the file's integrity before applying it; IF the file is corrupt or fails integrity validation, THEN THE Game SHALL display an error identifying the affected save slot and offer to start a new Career without overwriting the corrupt slot until the Player explicitly confirms replacement.
4. THE Game SHALL support a round-trip encode-decode of the save file format such that saving a Career state and then loading it produces a Career state object in which all persisted fields (money balance, owned components list, owned weapons list, Circuit progress index) are equal to the original.
5. THE Game SHALL support at least three named Career save slots, allowing multiple Careers to be stored simultaneously.
6. WHEN a Player attempts to save to a slot already occupied by a different Career, THE Game SHALL display a confirmation prompt before overwriting the existing save.

---

### Requirement 13: Platform and Performance

**User Story:** As a Player, I want the game to run smoothly on modern hardware without requiring specialised setup, so that I and my friends can easily play together.

#### Acceptance Criteria

1. THE Game SHALL run in a modern web browser (Chrome 120+, Firefox 120+, Edge 120+) without requiring installation of third-party plugins.
2. THE Game SHALL maintain a minimum of 60 frames per second during a Race with up to 8 Participants on reference hardware (a mid-range consumer PC or laptop from 2020 or later, defined as a quad-core CPU at 2.5 GHz or faster with 8 GB RAM and a DirectX 11-capable GPU).
3. THE Game SHALL complete loading from the main menu to a Race start screen in under 10 seconds on reference hardware with a 50 Mbps internet connection.
4. WHERE a native desktop build is provided, THE Game SHALL run on Windows 10+, macOS 12+, and Ubuntu 22.04+ without requiring elevated permissions.
5. THE Game SHALL store only the Player-chosen display name (1–20 characters) locally and SHALL NOT transmit, log, or persist any other player-identifying information to any server or storage medium.
6. IF the Game detects it is running in an unsupported browser or browser version, THEN THE Game SHALL display a message identifying the detected browser and the minimum supported versions, and SHALL NOT attempt to start the game loop.
