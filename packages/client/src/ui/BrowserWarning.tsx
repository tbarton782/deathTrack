import { Container, Graphics, Text, TextStyle } from 'pixi.js';

/**
 * Browser support warning screen (task 17.12).
 *
 * Requirement 13.1: the game runs in a modern web browser (Chrome 120+,
 * Firefox 120+, Edge 120+) without third-party plugins.
 *
 * Requirement 13.6: IF the game detects it is running in an unsupported browser
 * or browser version, THEN it displays a message identifying the detected
 * browser and the minimum supported versions, and does NOT attempt to start the
 * game loop.
 *
 * Following the established client UI convention (see {@link RaceResults},
 * {@link Settings}, HUD.tsx and MainMenu.tsx), the on-screen game UI is built
 * from PixiJS {@link Container} scene graphs rather than DOM/React trees. The
 * `.tsx` extension is retained only for naming consistency with the spec; no
 * JSX is used.
 *
 * The GPU-free half of this module — user-agent parsing
 * ({@link detectBrowser}), the support check ({@link isSupported} /
 * {@link shouldBlockStart}) and warning-message construction
 * ({@link buildWarningMessage}) — is pure and fully unit-testable in a headless
 * `node` environment. The UA string / navigator is INJECTED into the pure path
 * rather than read from a live global, so tests can exercise arbitrary
 * browsers. The {@link BrowserWarning} PixiJS overlay only consumes the
 * already-computed message to draw it; the draw path requires a WebGL context
 * and is validated in the browser, not in unit tests.
 */

// ---------------------------------------------------------------------------
// Supported-browser matrix
// ---------------------------------------------------------------------------

/** Identifier for a recognised browser engine/brand. */
export type BrowserName = 'Chrome' | 'Firefox' | 'Edge' | 'Safari' | 'Unknown';

/**
 * The minimum supported major version for each browser the game targets.
 *
 * Chrome / Firefox / Edge 120+ come straight from Requirement 13.1. Safari is
 * not named in the requirement matrix; it is included here with a sensible
 * modern minimum (Safari 17, the current major at the time the requirement's
 * "120+" line was written) so a detected Safari is handled deterministically
 * rather than falling through to the unknown-browser path. Any browser not in
 * this table is treated as unknown/unsupported.
 */
export const MINIMUM_SUPPORTED_VERSIONS: Readonly<Record<Exclude<BrowserName, 'Unknown'>, number>> = {
  Chrome: 120,
  Firefox: 120,
  Edge: 120,
  Safari: 17,
} as const;

/**
 * Human-readable summary of the supported-browser matrix, e.g.
 * `Chrome 120+, Edge 120+, Firefox 120+, Safari 17+`. Used in the warning
 * message so the player is told exactly what is required.
 */
export function formatSupportedVersions(
  minimums: Readonly<Record<string, number>> = MINIMUM_SUPPORTED_VERSIONS,
): string {
  return Object.keys(minimums)
    .sort()
    .map((name) => `${name} ${minimums[name]}+`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Detection (pure, GPU-free — UA injected)
// ---------------------------------------------------------------------------

/** The browser brand + major version parsed from a user-agent string. */
export interface DetectedBrowser {
  readonly name: BrowserName;
  /**
   * Parsed major version number, or `null` when the version could not be
   * determined (or the browser is unknown).
   */
  readonly version: number | null;
}

/**
 * Extracts the integer major version that follows `token` in `ua`, e.g.
 * `parseVersionAfter(ua, 'Firefox/')` returns `121` for `...Firefox/121.0`.
 * Returns `null` when the token is absent or is not followed by digits.
 */
function parseVersionAfter(ua: string, token: string): number | null {
  const index = ua.indexOf(token);
  if (index === -1) return null;
  const rest = ua.slice(index + token.length);
  const match = /^(\d+)/.exec(rest);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Detects the browser brand and major version from a user-agent string. Pure:
 * the UA string is passed in (injected) rather than read from a live
 * `navigator`, so this is fully testable headlessly.
 *
 * Brand order matters because UA strings are historically overlapping:
 * - Edge (Chromium) carries both `Edg/` and `Chrome/`; `Edg/` is checked first.
 * - Chrome carries `Chrome/` and `Safari/`; `Chrome/` is checked before Safari.
 * - Safari (the real one) carries `Safari/` and `Version/` but no `Chrome/`;
 *   its user-facing major version comes from `Version/`, not `Safari/`.
 *
 * An empty/whitespace UA or one matching none of the known brands yields
 * `{ name: 'Unknown', version: null }`.
 */
export function detectBrowser(userAgent: string): DetectedBrowser {
  const ua = (userAgent ?? '').trim();
  if (ua === '') return { name: 'Unknown', version: null };

  // Edge (Chromium) — must precede the Chrome check.
  if (ua.includes('Edg/') || ua.includes('Edge/') || ua.includes('EdgA/') || ua.includes('EdgiOS/')) {
    const version =
      parseVersionAfter(ua, 'Edg/') ??
      parseVersionAfter(ua, 'Edge/') ??
      parseVersionAfter(ua, 'EdgA/') ??
      parseVersionAfter(ua, 'EdgiOS/');
    return { name: 'Edge', version };
  }

  // Firefox.
  if (ua.includes('Firefox/')) {
    return { name: 'Firefox', version: parseVersionAfter(ua, 'Firefox/') };
  }

  // Chrome (and Chromium) — must precede the Safari check.
  if (ua.includes('Chrome/') || ua.includes('CriOS/')) {
    const version = parseVersionAfter(ua, 'Chrome/') ?? parseVersionAfter(ua, 'CriOS/');
    return { name: 'Chrome', version };
  }

  // Safari — real Safari has Safari/ and Version/ but not Chrome/.
  if (ua.includes('Safari/')) {
    return { name: 'Safari', version: parseVersionAfter(ua, 'Version/') };
  }

  return { name: 'Unknown', version: null };
}

/**
 * The user-agent string of the current environment, or `''` when no
 * `navigator` is available (e.g. a headless test/server context). This is the
 * only function that reads a live global; keep it out of the pure path.
 */
export function currentUserAgent(nav: { userAgent?: string } | undefined = typeof navigator !== 'undefined' ? navigator : undefined): string {
  return nav?.userAgent ?? '';
}

// ---------------------------------------------------------------------------
// Support decision (pure)
// ---------------------------------------------------------------------------

/**
 * Returns whether `detected` meets the minimum supported version for its
 * browser. Pure.
 *
 * - An unknown browser is unsupported (we cannot vouch for it).
 * - A known browser with an unparseable version is unsupported (we cannot
 *   confirm it meets the minimum).
 * - Otherwise supported iff the detected major version is at least the minimum.
 *   The comparison is `>=`, so a browser at exactly the minimum version is
 *   supported.
 */
export function isSupported(
  detected: DetectedBrowser,
  minimums: Readonly<Record<string, number>> = MINIMUM_SUPPORTED_VERSIONS,
): boolean {
  if (detected.name === 'Unknown') return false;
  if (detected.version === null) return false;
  const minimum = minimums[detected.name];
  if (minimum === undefined) return false;
  return detected.version >= minimum;
}

/**
 * Convenience inverse of {@link isSupported}: `true` when the game loop must be
 * BLOCKED from starting because the environment is unsupported (Requirement
 * 13.6). The App / GameLoop consults this at startup.
 */
export function shouldBlockStart(
  detected: DetectedBrowser,
  minimums: Readonly<Record<string, number>> = MINIMUM_SUPPORTED_VERSIONS,
): boolean {
  return !isSupported(detected, minimums);
}

/**
 * Builds the player-facing warning message for an unsupported environment.
 * Pure. The message names the detected browser (and its version when known)
 * and lists the minimum supported versions, satisfying Requirement 13.6.
 *
 * Passing a supported `detected` still produces a message; callers should only
 * surface it when {@link shouldBlockStart} is `true`.
 */
export function buildWarningMessage(
  detected: DetectedBrowser,
  minimums: Readonly<Record<string, number>> = MINIMUM_SUPPORTED_VERSIONS,
): string {
  const detectedLabel =
    detected.name === 'Unknown'
      ? 'an unrecognised browser'
      : detected.version !== null
        ? `${detected.name} ${detected.version}`
        : detected.name;

  return (
    `Deathtrack could not start because it is running in ${detectedLabel}, ` +
    `which is not supported. Please use one of: ${formatSupportedVersions(minimums)}.`
  );
}

/** The full result of evaluating the current environment for support. */
export interface BrowserSupportResult {
  readonly detected: DetectedBrowser;
  readonly supported: boolean;
  /** `true` when the game loop must not start (inverse of {@link supported}). */
  readonly blockStart: boolean;
  /**
   * The warning message to display when unsupported; `null` when the
   * environment is supported and no warning is needed.
   */
  readonly message: string | null;
}

/**
 * Evaluates a user-agent string end to end: detect → support check → message.
 * Pure and GPU-free; the entry point the App uses at startup by passing
 * {@link currentUserAgent}().
 */
export function evaluateBrowserSupport(
  userAgent: string,
  minimums: Readonly<Record<string, number>> = MINIMUM_SUPPORTED_VERSIONS,
): BrowserSupportResult {
  const detected = detectBrowser(userAgent);
  const supported = isSupported(detected, minimums);
  return {
    detected,
    supported,
    blockStart: !supported,
    message: supported ? null : buildWarningMessage(detected, minimums),
  };
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 220;
const PADDING = 24;

/**
 * Full-screen browser-warning overlay. A self-contained PixiJS
 * {@link Container} that draws the {@link buildWarningMessage} text over a dim
 * backing panel.
 *
 * Construction is GPU-free — PixiJS display objects instantiate without a WebGL
 * context — so the overlay can be created headlessly; only attaching it to a
 * live stage and presenting it requires a renderer. The overlay derives its
 * text via {@link evaluateBrowserSupport} so it stays consistent with the pure
 * support decision the game loop consults.
 */
export class BrowserWarning extends Container {
  private readonly result: BrowserSupportResult;

  /**
   * @param userAgent - The user-agent string to evaluate. Defaults to the live
   *   environment via {@link currentUserAgent}; inject a value for testing.
   * @param minimums - The supported-version matrix; defaults to
   *   {@link MINIMUM_SUPPORTED_VERSIONS}.
   */
  constructor(
    userAgent: string = currentUserAgent(),
    minimums: Readonly<Record<string, number>> = MINIMUM_SUPPORTED_VERSIONS,
  ) {
    super();
    this.label = 'browserWarning';
    this.result = evaluateBrowserSupport(userAgent, minimums);
    this.draw();
  }

  /** The evaluated support result (read-only view). */
  getResult(): BrowserSupportResult {
    return this.result;
  }

  /** Whether the game loop must be blocked from starting. */
  shouldBlockStart(): boolean {
    return this.result.blockStart;
  }

  private draw(): void {
    const panel = new Graphics();
    panel
      .roundRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT, 8)
      .fill({ color: 0x0a0a12, alpha: 0.96 })
      .stroke({ color: 0xaa3333, width: 2 });
    this.addChild(panel);

    const titleStyle = new TextStyle({
      fill: 0xff5555,
      fontFamily: 'monospace',
      fontSize: 22,
      fontWeight: 'bold',
    });
    const title = new Text({ text: 'UNSUPPORTED BROWSER', style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.addChild(title);

    const bodyStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 15,
      wordWrap: true,
      wordWrapWidth: PANEL_WIDTH - PADDING * 2,
      lineHeight: 22,
    });
    const body = new Text({
      text: this.result.message ?? 'Your browser is supported.',
      style: bodyStyle,
    });
    body.position.set(PADDING, PADDING + 40);
    this.addChild(body);
  }
}
