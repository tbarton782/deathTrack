/**
 * Browser entry point for the Death Track client (task 25.13).
 *
 * This is the thin script the `index.html` loads. It waits for the DOM, then
 * hands off to {@link bootstrap} (in `App.tsx`), which constructs the real
 * PixiJS renderer, mounts the canvas, evaluates browser support, and starts the
 * application state machine (main menu → … → race). All heavy, browser-only
 * wiring lives in `bootstrap`; this module only locates the mount point and
 * surfaces a fatal-startup error to the page.
 *
 * Requirements: 11.3, 13.1, 13.2
 */

import { bootstrap } from './App.js';

/** The element the PixiJS canvas is mounted into (see `index.html`). */
const MOUNT_ID = 'app';

/** Show a minimal, dependency-free error panel if startup fails. */
function showFatalError(message: string): void {
  const mount = document.getElementById(MOUNT_ID) ?? document.body;
  const panel = document.createElement('pre');
  panel.setAttribute('role', 'alert');
  panel.style.cssText =
    'color:#ff5555;background:#000;font:14px/1.4 monospace;padding:16px;margin:0;white-space:pre-wrap;';
  panel.textContent = `Death Track failed to start:\n\n${message}`;
  mount.appendChild(panel);
}

async function main(): Promise<void> {
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) {
    showFatalError(`missing mount element #${MOUNT_ID}`);
    return;
  }
  try {
    await bootstrap(mount);
  } catch (err) {
    showFatalError(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

// Start once the DOM is ready. When the module is evaluated after the document
// has already parsed (module scripts are deferred), run immediately.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main());
} else {
  void main();
}
