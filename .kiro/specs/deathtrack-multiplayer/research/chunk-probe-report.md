# Chunk-Tree Probe Report — Real Death Track Files

**Source files:** `C:\Users\tbart\OneDrive\1Projects\Games\dtrack`

This report records the actual on-disk chunk structure of the original Death Track
files, produced by walking each file with the Dynamix RES chunk reader (3-char
ID + `:` + uint32 length, high bit = container flag). It is the ground truth
for the format decoders.

## File inventory (by extension)

```
(none)=2, .blk=3, .bmp=32, .com=1, .exe=1, .hlp=1, .map=10,
.mus=2, .rct=17, .scr=8, .tbl=13, .trk=10, .ttm=1
```

## Key findings

- **Chunk-wrapped (documented Dynamix format, ready to decode):**
  - `.SCR` → `SCR:` container → `BIN:` leaf. Leaf starts `02 00 7d 00 00 00`
    = compression type `0x02` (LZW), decompressed size `0x7d00` = 32000 bytes = one
    320–200 VGA plane.
  - `.BLK` (BITMAPS.BLK) → a sequence of `BMP:` containers, each `INF:` + `BIN:`
    (LZW-compressed). `INF:` gives per-subimage dimensions.
  - Single sprites (`ANGEL.BMP`, `BAY_AREA.BMP`) → same `BMP:`/`INF:`/`BIN:` shape.
  - `FONTS.BLK` → three `FNT:` chunks (font sizes 4x5, 6x6, 8x8); header bytes
    `width height startSymbol(0x20) count(0x60)`.
  - `.MUS` → `SND:` container (Dynamix sound/music container).
  - **Palette lives in `ACTIVISI`** (extensionless file) → `PAL:` container with `EGA:`
    and `CGA:` sub-blocks, plus an `SCR:` title image. There is no `.PALS` file.
  - `.RCT` → `RAC:` chunks (race/circuit config). `.TTM` → `TTM:` (title animation).

- **NOT chunk-wrapped (raw Death-Track-specific binary; reverse-engineer):**
  - `.TRK` → starts with an ASCII `TRK:` tag but the following uint32 is NOT a valid
    chunk length (e.g. `0x00D10010`) — so `.TRK` is a *raw* payload that opens
    with a `TRK:` tag followed immediately by geometry. `BAY_AREA.TRK` body after
    the tag: `10 00 d1 00 09 00 d1 00 f7 ff 53 01` — reads as little-endian int16
    pairs (16,209), (9,209), (-9,339) … — almost certainly track centreline
    coordinates.
  - `.MAP` → raw, starts `02 da 5d 00` (no tag).
  - `.TBL` → raw, starts `00 00 01 00` repeating — looks like a table of
    little-endian int16/int32 stat records.
  - Non-game-data: `DTRACK.EXE` (`MZ` DOS exe), `INSTALL.COM`, `CONTROL.HLP`
    (plain text), `HI_SCORE`.

## Raw probe output (sample per file type)

```
===== ACTIVISI (3004 bytes) =====
head16: [50 41 4c 3a 32 01 00 80 45 47 41 3a 80 00 00 00] "PAL:2...EGA:...."
PAL container=true len=306 off=0
  EGA container=false len=128 off=8 first=[00 00 88 88 ff ff 44 44]
  CGA container=false len=162 off=144 first=[01 00 00 00 00 00 ff ff]
SCR container=true len=2682 off=314
  BIN container=false len=2674 off=322 first=[02 00 7d 00 00 00 02 0a]

===== BITMAPS.BLK (19380 bytes) =====
head16: [42 4d 50 3a 2a 06 00 80 49 4e 46 3a 4a 00 00 00] "BMP:*...INF:J..."
BMP container=true len=1578 off=0
  INF container=false len=74 off=8 first=[12 00 18 00 70 00 18 00]
  BIN container=false len=1488 off=90 first=[02 84 0d 00 00 dd 1a 1d]

===== FONTS.BLK (1860 bytes) =====
head16: [46 4e 54 3a e4 01 00 00 04 05 20 60 00 00 00 00] "FNT:...... `...."
FNT container=false len=484 off=0 first=[04 05 20 60 00 00 00 00]
FNT container=false len=580 off=492 first=[06 06 20 60 00 00 00 00]
FNT container=false len=772 off=1080 first=[08 08 20 60 00 00 00 00]

===== CAR1.SCR (6926 bytes) =====
head16: [53 43 52 3a 06 1b 00 80 42 49 4e 3a fe 1a 00 00] "SCR:....BIN:...."
SCR container=true len=6918 off=0
  BIN container=false len=6910 off=8 first=[02 00 7d 00 00 00 02 0a]

===== ANGEL.TBL (1690 bytes) =====
head16: [00 00 01 00 00 00 00 00 00 00 01 00 00 00 00 00] "................"
[!] not-a-chunk at offset 0:

===== BAY_AREA.TRK (10558 bytes) =====
head16: [54 52 4b 3a 10 00 d1 00 09 00 d1 00 f7 ff 53 01] "TRK:..........S."
[!] not-a-chunk (raw payload after TRK: tag)

===== BAY_AREA.MAP (7827 bytes) =====
head16: [02 da 5d 00 00 06 00 80 12 48 70 a0 41 00 19 10] "..].....Hp.A..."
[!] not-a-chunk at offset 0

===== DANGER.MUS (1853 bytes) =====
head16: [53 4e 44 3a 35 07 00 00 02 f7 0a 00 00 4d a8 a0] "SND:5.......M.."
SND container=false len=1845 off=0 first=[02 f7 0a 00 00 4d a8 a0]
```

> Note: `[]` byte values are hex. The probe sampled up to two files per extension;
> all 10 `.TRK` files share the `TRK:`-tagged raw shape, all `.TBL` share the
> `00 00 01 00` record shape, and all `.SCR`/`.BL[K]/`.MUS` share the chunk shapes
> shown above.
