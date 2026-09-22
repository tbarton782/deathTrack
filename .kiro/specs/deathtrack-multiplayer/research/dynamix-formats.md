# Dynamix Asset Format Reference (Death Track, 1994)

## Purpose

This document is the authoritative reference for the **real** on-disk formats used by
the original *Death Track* (Dynamix, 1994) game files located in
`C:\Users\tbart\OneDrive\1Projects\Games\dtrack`. It supersedes the invented/assumed
layouts that earlier tasks (spec section 4) were built against. Every format below was
confirmed either against the public DGCTF ModdingWiki documentation for Dynamix engines
or against the real bytes of the Death Track files via a reverse-engineering probe.

Formats fall into two groups:

1. **Documented Dynamix formats** — the chunk container, the three compression schemes,
   palettes, full-screen images, fonts, and sprites. These are well understood and are
   summarised here with byte-layout tables so the decoders can be written directly.
2. **Death-Track-specific payloads** — `.TRK` (track geometry + waypoints), `.MAP`
   (minimap), and `.TBL` (stat tables). These are **not** documented on any public wiki
   and must be reverse-engineered from the real bytes. Their byte layouts are marked
   **TBD** below; do **not** invent specific layouts for them.

### Sources and attribution

Format knowledge for the documented Dynamix structures comes from the DGCTF ModdingWiki
(shikadi.net) and the associated community reverse-engineering effort:

- The Incredible Machine Image Format — <https://moddingwiki.shikadi.net/wiki/The_Incredible_Machine_Image_Format>
- RES Format (Stellar 7) — <https://moddingwiki.shikadi.net/wiki/RES_Format_(Stellar_7)>
- Dynamix Font Format v4-v5 — <https://moddingwiki.shikadi.net/wiki/Dynamix_Font_Format_v4-v5>
- VGA Palette — <https://moddingwiki.shikadi.net/wiki/VGA_Palette>

> **Compliance note:** Format documentation was rephrased/summarised for compliance with
> source licensing; see the linked sources above for the originals. The byte-layout tables
> below are our own descriptions, not verbatim reproductions.

All multi-byte integers are **little-endian** unless stated otherwise.

---

## 1. Chunk container (Dynamix RES chunk tree)

Death Track files are trees of chunks. Every chunk has a fixed 8-byte header followed by
its data.

| Offset | Type       | Field              | Notes |
|--------|------------|--------------------|-------|
| 0      | `char[4]`  | `contentType`      | A 3-character ASCII ID followed by `':'`, e.g. `"RTK:"`, `"BMP:"`, `"FNT:"`, `"SND:"`, `"SCR:"`, `"MAP:"`, `"PAL:"`, `"VGA:"`, `"INF:"`, `"OFF:"`, `"SCN:"`, `"BIN:"` |
| 4      | `uint32`   | `isFolder_length`  | Most-significant bit (bit 31) is the **folder/container flag**; the low 31 bits are the **byte length** of the data that follows |
| 8      | `byte[N]`  | `data`             | `N` = low 31 bits of `isFolder_length` |

Interpretation of the length word:

- `isContainer = (isFolder_length & 0x80000000) !== 0`
- `dataLength  = isFolder_length & 0x7FFFFFFF`

If `isContainer` is set, `data` is itself a sequence of nested chunks (parse recursively).
Otherwise `data` is a raw/compressed leaf payload. Nesting is generally **one level deep**
in Death Track (a container holds a small set of leaf chunks).

### `ChunkReader` contract (implementation guidance)

A foundational `ChunkReader` walks this tree and yields a node structure like:

```
ChunkNode {
  id: string;            // 3-char ID, ':' stripped, e.g. "RTK", "BMP"
  isContainer: boolean;
  length: number;        // low 31 bits
  data: Uint8Array;      // raw bytes of this chunk's payload (leaf) 
  children: ChunkNode[]; // populated when isContainer === true
}
```

The reader should validate that each child's declared length does not exceed the parent's
remaining bytes, and should surface the byte offset on malformed input.

---

## 2. Compression schemes (RES format)

Compressed leaf entries (per the RES format) start with a small header, then the
compressed bytes:

| Offset | Type     | Field              | Notes |
|--------|----------|--------------------|-------|
| 0      | `uint8`  | `compressionType`  | `0x00` none, `0x01` RLE, `0x02` LZW, `0x03` LH1 |
| 1      | `uint32` | `decompressedSize` | Size of the output buffer in bytes |
| 5      | `byte[]` | `compressedData`   | Remainder of the leaf |

A shared decompressor module should expose one entry point per method and a dispatcher
keyed on `compressionType`. `0x00` (none) simply copies `decompressedSize` bytes.

### 2.1 RLE (method `0x01`) — Dynamix font RLE

Code-based RLE using 1-byte codes. For each code byte read:

- If the **high bit** is set → **Repeat**: the low 7 bits give the count `n`; read the next
  single byte and emit it `n` times.
- Otherwise → **Copy**: the low 7 bits give the count `n`; copy the next `n` bytes verbatim
  to the output.

Continue until `decompressedSize` bytes have been produced.

### 2.2 LZW (method `0x02`)

Dynamix variable-width LZW:

- Codes are **dynamic width, 9 to 12 bits**, packed **little-endian** at the bit level.
- The dictionary starts populated with the single-byte values; the **first emitted code is
  257**.
- Code **256** is the **dictionary reset** signal. On reset: if the total number of codes
  read so far is **not divisible by 8**, skip (discard) codewords until the running count
  *is* divisible by 8, then continue with the reset dictionary at 9-bit width.
- Code width grows from 9 → 12 bits as the dictionary fills, in the standard LZW manner.

### 2.3 LH1 (method `0x03`)

LH1 is the `'lh1'` method as used inside LHA archives (LZSS + adaptive/dynamic Huffman).
Reuse a known-correct `lh1` implementation rather than reinventing it; verify output length
against `decompressedSize`.

---

## 3. Palettes — `PAL:` / `VGA:`

A `PAL:` container holds a `VGA:` sub-block containing the palette entries.

| Field        | Type              | Notes |
|--------------|-------------------|-------|
| `entries[]`  | `uint8[3]` each   | 3 bytes per colour: R, G, B |

- Each channel value is **0–63** (6-bit VGA DAC range).
- Scale to 0–255 for modern output: `out = (v << 2)` (fast) or `out = round(v * 255 / 63)`
  (exact). Prefer the exact form for colour fidelity.
- A full palette is 256 entries (768 bytes) but sub-palettes may be shorter; decode by the
  `VGA:` chunk length.

---

## 4. Full-screen images — `SCR:`

`SCR:` holds a full-screen 320×200 image. Two forms exist:

### 4.1 VGA form (two planes)

The VGA form is split into **two 32000-byte planes**, at **2 pixels per byte** (each nibble
is part of a palette index).

- Plane A holds the **less-significant** nibbles; Plane B holds the **more-significant**
  bits.
- For each byte, the high nibble and low nibble correspond to two horizontally adjacent
  pixels.
- Combine the corresponding nibbles from Plane A and Plane B to form the full palette index
  per pixel:
  - For each pixel, take its nibble from Plane A and its nibble from Plane B and combine
    (Plane B contributes the more-significant bits) to yield the final 0–255 palette index.
- Apply the palette (section 3) to produce RGBA.

Total: 2 × 32000 = 64000 bytes = 320 × 200 pixels.

### 4.2 EGA form (single plane)

The EGA form is a single **32000-byte BIN** (`BIN:`), decoded against the EGA palette.

---

## 5. Sprites — `BMP:` (The Incredible Machine Image Format)

A `BMP:` container holds an `INF:` info chunk plus image data. The image data appears in one
of two forms: **SCN/OFF** (subimage table) or **BIN** (single compressed image).

### 5.1 `INF:` info chunk

| Offset | Type              | Field       | Notes |
|--------|-------------------|-------------|-------|
| 0      | `uint16`          | `imgCount`  | Number of subimages |
| 2      | `uint16[imgCount]`| `widths`    | Per-subimage width |
| ...    | `uint16[imgCount]`| `heights`   | Per-subimage height |

### 5.2 SCN/OFF form

- **`OFF:` chunk** — `uint32[]` offsets into the `SCN:` chunk, one per subimage. The first
  offset is `0`.
- **`SCN:` chunk** — per-subimage compressed pixel data using a **2-bit-command RLE**. For
  each code byte, the **top 2 bits** are the command and the **low 6 bits** are the value:

  | Top 2 bits | Command    | Meaning |
  |------------|------------|---------|
  | `00`       | line skip  | Advance rows; skipped pixels are transparent |
  | `01`       | short skip | Skip within a row; the special code `0x40` marks **end-of-subimage**. Skips are transparent |
  | `10`       | repeat     | The next byte is the 4-bit pixel value; emit it `value` times |
  | `11`       | copy       | The following `(value + 1) >> 1` bytes each hold **two 4-bit pixels** (most-significant nibble first) |

  - A leading **`addValue` byte** is added to every **non-transparent** pixel value.
  - Skips produce **transparent** pixels (no colour written).

### 5.3 BIN form

A single compressed image:

| Offset | Type     | Field              | Notes |
|--------|----------|--------------------|-------|
| 0      | `uint8`  | `compressionMethod`| 0–3 (section 2) |
| 1      | `uint32` | `uncompressedSize` | Output size in bytes |
| 5      | `byte[]` | `compressedData`   | 4-bpp packed pixel data after decompression |

---

## 6. Fonts — `FNT:` (Dynamix Font Format v4/v5)

Inside the `FNT:` chunk data:

| Offset | Type     | Field              | Notes |
|--------|----------|--------------------|-------|
| 0      | `uint8`  | `version`          | `0xFF` = 1bpp (v4), `0xFD` = 8bpp (v5) |
| 1      | `uint8`  | `fontWidth`        | Nominal cell width |
| 2      | `uint8`  | `fontHeight`       | Cell height (glyph bitmap row count) |
| 3      | `uint8`  | `baseLine`         | Baseline row |
| 4      | `uint8`  | `startSymbol`      | First character code present |
| 5      | `uint8`  | `nrOfSymbols`      | Number of glyphs |
| 6      | `uint16` | `symbolDataSize`   | Size of symbol data region |
| 8      | `uint8`  | `compressionMethod`| 0–3 (section 2) |
| 9      | `uint32` | `uncompressedSize` | Decompressed symbol-data size |
| 13     | `byte[]` | `compressedSymbolData` | Decompress per method |

Once decompressed, the symbol data begins with:

1. `uint16[nrOfSymbols]` — per-glyph **offsets** into the glyph bitmap region.
2. `uint8[nrOfSymbols]`  — per-glyph **widths**.
3. Glyph bitmaps — for each glyph, `height = fontHeight` rows with
   `stride = ((width * bpp) + 7) / 8` bytes per row, where `bpp` is 1 (v4) or 8 (v5).

---

## 7. Reverse-engineer from bytes (undocumented)

The following payloads are **not** documented on any public wiki. Their layouts must be
determined by inspecting the real Death Track bytes in a later phase. **Do not invent byte
layouts** — mark all as **layout TBD** until confirmed against the files.

### 7.1 `RTK:` — `.TRK` track geometry + waypoints — **layout TBD**

The `.TRK` files carry an `RTK:` payload (likely wrapped in the chunk container). Contents
to recover by reverse engineering:

- Road geometry / segment centreline and width data.
- Jump ramp placements and angles.
- The AI **waypoint graph** (nodes + edges).
- Pit lane entry/exit and path.
- Hazard zones and scenery placements.

Reverse-engineer from bytes; layout TBD. Verify the decoder against **all 10 tracks**.

### 7.2 `.MAP` — minimap payload — **layout TBD**

The overhead minimap data. Reverse-engineer from bytes; layout TBD.

### 7.3 `.TBL` — per-car / shape-library container — **structure decoded (record interiors TBD)**

`.TBL` files lead with **binary version/flags words** (`00 00 01 00 …`), i.e. there is
**no ASCII magic** and they are **not** chunk-wrapped. They are **not** the numeric
stat tables section 4 assumed — the per-character files hold the cars' 3D vector-mesh
geometry (see `SHAPE.TBL`, the 78 KB shared shape library).

**Confirmed structure of a per-car `.TBL`** (verified across all 12 real files —
`ANGEL`, `CRIMSON`, `LURKER`, `MANIAC`, `MEGA`, `MELISSA`, `MENACE`, `MYCAR0-2`,
`SLY`, `WRECKER`):

- a fixed header whose first `uint16` is a version/flags word (`0x0000` in every file)
  and whose byte at `0x10` is a small record-region marker;
- at byte **`0x1e`**, a **`0xffff`-terminated array of `uint16` file offsets**. In every
  file these offsets are strictly increasing and land inside `[0, byteLength)`; they
  partition the file body into a sequence of variable-length **records** (each record
  runs from its offset to the next, the last to EOF). Decoding is exact: the records tile
  the body contiguously with no gaps or overlaps.

`SHAPE.TBL` is a **larger offset-indexed container** of the same family (a leading table
of monotonically-increasing offsets, stored `uint16`-in-low-half-of-4-bytes, then the
referenced record data) — it is **not** a per-car file and does not use the `0x1e`
per-car table layout.

**Decoded, not invented:** `packages/tools/src/parsers/RealTblDecoder.ts` decodes the
per-car header + offset table + record byte-slices (CLI: `deathtrack-tools --tbl <dir>`;
committed structural report at `research/tbl-structure-report.txt`). The **meaning of the
bytes inside each record** (mesh vertices / face lists / attribute blocks) is left
**opaque** — it is not recoverable from the bytes without inventing structure, which these
notes forbid. There are **no numeric car/weapon stat fields** in these files, confirming
the recreation's `CHASSIS_CATALOGUE`/`WEAPON_CATALOGUE` are authored design data.

### 7.4 Filename → `trackId` map

The real track filenames map to internal track IDs as follows:

| Real filename | `trackId`     |
|---------------|---------------|
| `BAY_AREA`    | `bay_area`    |
| `BOSTON`      | `boston`      |
| `CHICAGO`     | `chicago`     |
| `HOUSTON`     | `houston`     |
| `LA`          | `los_angeles` |
| `NYC`         | `manhattan`   |
| `ORLANDO`     | `orlando`     |
| `PHOENIX`     | `phoenix`     |
| `SEATTLE`     | `seattle`     |
| `ST_LOUIS`    | `st_louis`    |
