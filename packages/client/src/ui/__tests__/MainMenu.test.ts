import { describe, expect, it, vi } from 'vitest';
import {
  MAIN_MENU_ACTIONS,
  MAIN_MENU_LABELS,
  DEFAULT_MAIN_MENU_LAYOUT,
  createMainMenuButtonModels,
  isInsideRegion,
  type MainMenuAction,
  type MainMenuHandlers,
} from '../MainMenu';

/**
 * These tests exercise only the GPU-free main-menu *button model*: the action
 * list, the labels required by requirement 11.3, the layout math and hit
 * regions, and the handler wiring. None of this needs a WebGL context, so it
 * runs headless in the `node` vitest environment.
 *
 * The actual PixiJS drawing (the {@link MainMenu} class producing Graphics/Text
 * on a real renderer) is validated in the browser, not here.
 *
 * Validates: Requirements 11.3 (main menu: Start Career, Host Session, Join
 * Session, View High Scores, Settings).
 */

function makeHandlers(): MainMenuHandlers & { calls: MainMenuAction[] } {
  const calls: MainMenuAction[] = [];
  return {
    calls,
    onStartCareer: () => calls.push('startCareer'),
    onHostSession: () => calls.push('hostSession'),
    onJoinSession: () => calls.push('joinSession'),
    onViewHighScores: () => calls.push('viewHighScores'),
    onSettings: () => calls.push('settings'),
  };
}

describe('main menu actions and labels', () => {
  it('defines exactly the five required actions in display order', () => {
    expect([...MAIN_MENU_ACTIONS]).toEqual([
      'startCareer',
      'hostSession',
      'joinSession',
      'viewHighScores',
      'settings',
    ]);
  });

  it('labels each action with the caption required by 11.3', () => {
    expect(MAIN_MENU_LABELS).toEqual({
      startCareer: 'Start Career',
      hostSession: 'Host Session',
      joinSession: 'Join Session',
      viewHighScores: 'View High Scores',
      settings: 'Settings',
    });
  });
});

describe('createMainMenuButtonModels', () => {
  it('produces one button per action, in order, with the right labels', () => {
    const models = createMainMenuButtonModels(makeHandlers());
    expect(models.map((m) => m.action)).toEqual([...MAIN_MENU_ACTIONS]);
    expect(models.map((m) => m.label)).toEqual([
      'Start Career',
      'Host Session',
      'Join Session',
      'View High Scores',
      'Settings',
    ]);
  });

  it('stacks buttons vertically with a consistent step (height + gap)', () => {
    const layout = DEFAULT_MAIN_MENU_LAYOUT;
    const models = createMainMenuButtonModels(makeHandlers(), layout);
    const step = layout.buttonHeight + layout.gap;
    models.forEach((m, i) => {
      expect(m.region.x).toBe(layout.x);
      expect(m.region.y).toBe(layout.y + i * step);
      expect(m.region.width).toBe(layout.buttonWidth);
      expect(m.region.height).toBe(layout.buttonHeight);
    });
  });

  it('produces non-overlapping hit regions', () => {
    const models = createMainMenuButtonModels(makeHandlers());
    for (let i = 1; i < models.length; i++) {
      const prev = models[i - 1]!.region;
      const curr = models[i]!.region;
      expect(curr.y).toBeGreaterThanOrEqual(prev.y + prev.height);
    }
  });

  it('honours a custom layout', () => {
    const models = createMainMenuButtonModels(makeHandlers(), {
      x: 10,
      y: 20,
      buttonWidth: 100,
      buttonHeight: 30,
      gap: 5,
    });
    expect(models[0]!.region).toEqual({ x: 10, y: 20, width: 100, height: 30 });
    expect(models[1]!.region).toEqual({ x: 10, y: 55, width: 100, height: 30 });
  });

  it('wires each button to its matching handler', () => {
    const handlers = makeHandlers();
    const models = createMainMenuButtonModels(handlers);
    for (const model of models) {
      model.activate();
    }
    expect(handlers.calls).toEqual([...MAIN_MENU_ACTIONS]);
  });

  it('invokes only the activated button handler, once per activation', () => {
    const spies = {
      onStartCareer: vi.fn(),
      onHostSession: vi.fn(),
      onJoinSession: vi.fn(),
      onViewHighScores: vi.fn(),
      onSettings: vi.fn(),
    };
    const models = createMainMenuButtonModels(spies);
    models.find((m) => m.action === 'joinSession')!.activate();
    expect(spies.onJoinSession).toHaveBeenCalledTimes(1);
    expect(spies.onStartCareer).not.toHaveBeenCalled();
    expect(spies.onHostSession).not.toHaveBeenCalled();
    expect(spies.onViewHighScores).not.toHaveBeenCalled();
    expect(spies.onSettings).not.toHaveBeenCalled();
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
