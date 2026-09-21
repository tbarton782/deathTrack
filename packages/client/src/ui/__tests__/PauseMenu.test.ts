import { describe, expect, it, vi } from 'vitest';
import type { ParticipantId } from '@deathtrack/shared';
import {
  PAUSE_MENU_ACTIONS,
  PAUSE_MENU_LABELS,
  DEFAULT_PAUSE_MENU_LAYOUT,
  createPauseMenuButtonModels,
  isInsideRegion,
  makePauseNotification,
  makeResumeNotification,
  type PauseMenuAction,
  type PauseMenuHandlers,
} from '../PauseMenu';

/**
 * These tests exercise only the GPU-free pause-menu *button model*: the action
 * list, the labels required by requirement 11.5, the layout math and hit
 * regions, the handler wiring, and the pause/resume notification builders.
 * None of this needs a WebGL context, so it runs headless in the `node` vitest
 * environment.
 *
 * The actual PixiJS drawing (the {@link PauseMenu} class producing
 * Graphics/Text on a real renderer) is validated in the browser, not here.
 *
 * Validates: Requirements 11.5 (pause menu: Resume / Quit; in multiplayer the
 * simulation keeps running for remote Participants and all others receive a
 * pause notification).
 */

function makeHandlers(): PauseMenuHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onPause: () => calls.push('pause'),
    onResume: () => calls.push('resume'),
    onQuit: () => calls.push('quit'),
  };
}

describe('pause menu actions and labels', () => {
  it('defines exactly the two required actions in display order', () => {
    expect([...PAUSE_MENU_ACTIONS]).toEqual(['resume', 'quit']);
  });

  it('labels each action with the caption required by 11.5', () => {
    expect(PAUSE_MENU_LABELS).toEqual({
      resume: 'Resume',
      quit: 'Quit to Main Menu',
    });
  });
});

describe('createPauseMenuButtonModels', () => {
  it('produces one button per action, in order, with the right labels', () => {
    const models = createPauseMenuButtonModels(makeHandlers());
    expect(models.map((m) => m.action)).toEqual([...PAUSE_MENU_ACTIONS]);
    expect(models.map((m) => m.label)).toEqual(['Resume', 'Quit to Main Menu']);
  });

  it('stacks buttons vertically with a consistent step (height + gap)', () => {
    const layout = DEFAULT_PAUSE_MENU_LAYOUT;
    const models = createPauseMenuButtonModels(makeHandlers(), layout);
    const step = layout.buttonHeight + layout.gap;
    models.forEach((m, i) => {
      expect(m.region.x).toBe(layout.x);
      expect(m.region.y).toBe(layout.y + i * step);
      expect(m.region.width).toBe(layout.buttonWidth);
      expect(m.region.height).toBe(layout.buttonHeight);
    });
  });

  it('produces non-overlapping hit regions', () => {
    const models = createPauseMenuButtonModels(makeHandlers());
    for (let i = 1; i < models.length; i++) {
      const prev = models[i - 1]!.region;
      const curr = models[i]!.region;
      expect(curr.y).toBeGreaterThanOrEqual(prev.y + prev.height);
    }
  });

  it('honours a custom layout', () => {
    const models = createPauseMenuButtonModels(makeHandlers(), {
      x: 10,
      y: 20,
      buttonWidth: 100,
      buttonHeight: 30,
      gap: 5,
    });
    expect(models[0]!.region).toEqual({ x: 10, y: 20, width: 100, height: 30 });
    expect(models[1]!.region).toEqual({ x: 10, y: 55, width: 100, height: 30 });
  });

  it('fires onResume when the Resume button is activated', () => {
    const handlers = makeHandlers();
    const models = createPauseMenuButtonModels(handlers);
    models.find((m) => m.action === 'resume')!.activate();
    expect(handlers.calls).toEqual(['resume']);
  });

  it('fires onQuit when the Quit button is activated', () => {
    const handlers = makeHandlers();
    const models = createPauseMenuButtonModels(handlers);
    models.find((m) => m.action === 'quit')!.activate();
    expect(handlers.calls).toEqual(['quit']);
  });

  it('does not itself pause/notify or halt any simulation — only button callbacks run', () => {
    const spies = {
      onPause: vi.fn(),
      onResume: vi.fn(),
      onQuit: vi.fn(),
    };
    // Building the model must not open/pause anything; opening is a distinct
    // lifecycle event handled by the PauseMenu overlay, not the model builder.
    const models = createPauseMenuButtonModels(spies);
    expect(spies.onPause).not.toHaveBeenCalled();
    expect(spies.onResume).not.toHaveBeenCalled();
    expect(spies.onQuit).not.toHaveBeenCalled();

    // Activating one button invokes only that button's handler, once. The menu
    // has no ability to stop remote simulation — it merely calls callbacks.
    models.find((m) => m.action === 'resume')!.activate();
    expect(spies.onResume).toHaveBeenCalledTimes(1);
    expect(spies.onQuit).not.toHaveBeenCalled();
    expect(spies.onPause).not.toHaveBeenCalled();
  });

  it('invokes only the activated button handler, once per activation', () => {
    const actions: PauseMenuAction[] = [...PAUSE_MENU_ACTIONS];
    for (const target of actions) {
      const spies = {
        onPause: vi.fn(),
        onResume: vi.fn(),
        onQuit: vi.fn(),
      };
      const models = createPauseMenuButtonModels(spies);
      models.find((m) => m.action === target)!.activate();
      const expectedResume = target === 'resume' ? 1 : 0;
      const expectedQuit = target === 'quit' ? 1 : 0;
      expect(spies.onResume).toHaveBeenCalledTimes(expectedResume);
      expect(spies.onQuit).toHaveBeenCalledTimes(expectedQuit);
      expect(spies.onPause).not.toHaveBeenCalled();
    }
  });
});

describe('pause / resume notifications (Requirement 11.5)', () => {
  it('builds a paused event for the pausing participant', () => {
    const id = 3 as ParticipantId;
    expect(makePauseNotification(id)).toEqual({ type: 'paused', participantId: 3 });
  });

  it('builds a resumed event for the resuming participant', () => {
    const id = 5 as ParticipantId;
    expect(makeResumeNotification(id)).toEqual({ type: 'resumed', participantId: 5 });
  });
});

describe('isInsideRegion', () => {
  const region = { x: 100, y: 200, width: 50, height: 20 };

  it('accepts points inside and on the top-left edge', () => {
    expect(isInsideRegion(region, 100, 200)).toBe(true);
    expect(isInsideRegion(region, 149, 219)).toBe(true);
  });

  it('rejects points on the far edges and outside', () => {
    expect(isInsideRegion(region, 150, 200)).toBe(false); // right edge is exclusive
    expect(isInsideRegion(region, 100, 220)).toBe(false); // bottom edge is exclusive
    expect(isInsideRegion(region, 99, 200)).toBe(false);
    expect(isInsideRegion(region, 100, 199)).toBe(false);
  });
});
