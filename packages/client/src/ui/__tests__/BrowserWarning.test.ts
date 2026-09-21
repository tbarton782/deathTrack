import { describe, expect, it } from 'vitest';
import {
  MINIMUM_SUPPORTED_VERSIONS,
  buildWarningMessage,
  detectBrowser,
  evaluateBrowserSupport,
  formatSupportedVersions,
  isSupported,
  shouldBlockStart,
  type DetectedBrowser,
} from '../BrowserWarning';

/**
 * These tests exercise only the GPU-free browser-support model: user-agent
 * parsing, the support decision, and warning-message construction. They run in
 * the headless `node` vitest environment with UA strings injected — no live
 * `navigator` is touched.
 *
 * The PixiJS `BrowserWarning` overlay draw path requires a WebGL context and is
 * validated in the browser, not here.
 *
 * Validates: Requirements 13.1 (supported browsers Chrome/Firefox/Edge 120+)
 * and 13.6 (unsupported browsers get a message naming the detected browser and
 * the minimum supported versions, and the game loop is blocked from starting).
 */

// Representative real-world user-agent strings.
const UA = {
  chrome121:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  chrome120:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chrome119:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  firefox121:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  firefox115:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0',
  edge121:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  edge118:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0',
  safari17:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  safari15:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15',
  ie11:
    'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko',
  empty: '',
} as const;

describe('detectBrowser', () => {
  it('parses Chrome brand and major version', () => {
    expect(detectBrowser(UA.chrome121)).toEqual<DetectedBrowser>({
      name: 'Chrome',
      version: 121,
    });
  });

  it('parses Firefox brand and major version', () => {
    expect(detectBrowser(UA.firefox121)).toEqual<DetectedBrowser>({
      name: 'Firefox',
      version: 121,
    });
  });

  it('detects Edge before Chrome despite the Chrome/ token', () => {
    expect(detectBrowser(UA.edge121)).toEqual<DetectedBrowser>({
      name: 'Edge',
      version: 121,
    });
  });

  it('detects Chrome before Safari despite the Safari/ token', () => {
    expect(detectBrowser(UA.chrome120).name).toBe('Chrome');
  });

  it('parses Safari version from the Version/ token, not Safari/', () => {
    expect(detectBrowser(UA.safari17)).toEqual<DetectedBrowser>({
      name: 'Safari',
      version: 17,
    });
  });

  it('returns Unknown for an unrecognised browser (IE11)', () => {
    expect(detectBrowser(UA.ie11)).toEqual<DetectedBrowser>({
      name: 'Unknown',
      version: null,
    });
  });

  it('returns Unknown for an empty user-agent string', () => {
    expect(detectBrowser(UA.empty)).toEqual<DetectedBrowser>({
      name: 'Unknown',
      version: null,
    });
  });
});

describe('isSupported', () => {
  it('supports a known browser above the minimum version', () => {
    expect(isSupported(detectBrowser(UA.chrome121))).toBe(true);
    expect(isSupported(detectBrowser(UA.firefox121))).toBe(true);
    expect(isSupported(detectBrowser(UA.edge121))).toBe(true);
    expect(isSupported(detectBrowser(UA.safari17))).toBe(true);
  });

  it('supports a browser at exactly the minimum version (boundary)', () => {
    // Chrome minimum is 120.
    expect(MINIMUM_SUPPORTED_VERSIONS.Chrome).toBe(120);
    expect(isSupported(detectBrowser(UA.chrome120))).toBe(true);
  });

  it('rejects a known browser one major below the minimum', () => {
    expect(isSupported(detectBrowser(UA.chrome119))).toBe(false);
    expect(isSupported(detectBrowser(UA.firefox115))).toBe(false);
    expect(isSupported(detectBrowser(UA.edge118))).toBe(false);
    expect(isSupported(detectBrowser(UA.safari15))).toBe(false);
  });

  it('rejects an unknown browser', () => {
    expect(isSupported(detectBrowser(UA.ie11))).toBe(false);
  });

  it('rejects a known browser with an unparseable version', () => {
    expect(isSupported({ name: 'Chrome', version: null })).toBe(false);
  });
});

describe('shouldBlockStart', () => {
  it('blocks startup exactly when unsupported (inverse of isSupported)', () => {
    const supported = detectBrowser(UA.chrome121);
    const unsupported = detectBrowser(UA.chrome119);
    expect(shouldBlockStart(supported)).toBe(false);
    expect(shouldBlockStart(unsupported)).toBe(true);
  });
});

describe('buildWarningMessage', () => {
  it('names the detected browser + version and lists the minimums', () => {
    const message = buildWarningMessage(detectBrowser(UA.chrome119));
    expect(message).toContain('Chrome 119');
    expect(message).toContain(formatSupportedVersions());
    expect(message).toContain('Chrome 120+');
    expect(message).toContain('Firefox 120+');
    expect(message).toContain('Edge 120+');
  });

  it('describes an unrecognised browser without a version', () => {
    const message = buildWarningMessage(detectBrowser(UA.ie11));
    expect(message).toContain('unrecognised browser');
    expect(message).toContain('Chrome 120+');
  });
});

describe('formatSupportedVersions', () => {
  it('lists every supported browser with its minimum, sorted', () => {
    expect(formatSupportedVersions()).toBe(
      'Chrome 120+, Edge 120+, Firefox 120+, Safari 17+',
    );
  });
});

describe('evaluateBrowserSupport', () => {
  it('returns supported with no message for a modern browser', () => {
    const result = evaluateBrowserSupport(UA.firefox121);
    expect(result.supported).toBe(true);
    expect(result.blockStart).toBe(false);
    expect(result.message).toBeNull();
    expect(result.detected).toEqual({ name: 'Firefox', version: 121 });
  });

  it('returns blockStart with a naming message for an outdated browser', () => {
    const result = evaluateBrowserSupport(UA.edge118);
    expect(result.supported).toBe(false);
    expect(result.blockStart).toBe(true);
    expect(result.message).toContain('Edge 118');
    expect(result.message).toContain('Edge 120+');
  });
});
