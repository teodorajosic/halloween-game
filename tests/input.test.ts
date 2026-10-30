import { describe, expect, it, vi } from 'vitest';
import { createKeyboard } from '../src/input.js';
import {
  attachKeyboard,
  wireKeyboardToGame,
  type KeyboardTarget,
  type KeyEventLike,
} from '../src/input-dom.js';
import type { Intent } from '../src/types.js';

describe('createKeyboard', () => {
  it('2.1: Space and ArrowUp give primary, other keys give nothing', () => {
    expect(createKeyboard().keyDown('Space', false)).toBe('primary');
    expect(createKeyboard().keyDown('ArrowUp', false)).toBe('primary');
    expect(createKeyboard().keyDown('KeyA', false)).toBeNull();
  });

  it('2.2: a held key fires once; a second keyDown without keyUp gives nothing', () => {
    const keyboard = createKeyboard();
    expect(keyboard.keyDown('Space', false)).toBe('primary');
    expect(keyboard.keyDown('Space', false)).toBeNull();
  });

  it('2.2: auto-repeat gives nothing', () => {
    expect(createKeyboard().keyDown('Space', true)).toBeNull();
  });

  it('2.2: after keyUp the key fires again', () => {
    const keyboard = createKeyboard();
    keyboard.keyDown('Space', false);
    keyboard.keyUp('Space');
    expect(keyboard.keyDown('Space', false)).toBe('primary');
  });

  it('tracks held keys per code: ArrowUp fires while Space is held', () => {
    const keyboard = createKeyboard();
    keyboard.keyDown('Space', false);
    expect(keyboard.keyDown('ArrowUp', false)).toBe('primary');
  });

  it('2.2: after reset() a held key fires again', () => {
    const keyboard = createKeyboard();
    keyboard.keyDown('Space', false);
    keyboard.reset();
    expect(keyboard.keyDown('Space', false)).toBe('primary');
  });

  it('2.7: ten press/release cycles give exactly ten intents', () => {
    const keyboard = createKeyboard();
    const intents: Intent[] = [];
    for (let i = 0; i < 10; i += 1) {
      const intent = keyboard.keyDown('Space', false);
      if (intent !== null) intents.push(intent);
      keyboard.keyDown('Space', true); // auto-repeat while held
      keyboard.keyUp('Space');
    }
    expect(intents).toEqual(Array<Intent>(10).fill('primary'));
  });
});

/** A fake window: records listeners and lets a test fire events at them. */
function fakeTarget() {
  const keyListeners = new Map<string, Set<(event: KeyEventLike) => void>>();
  const plainListeners = new Map<string, Set<() => void>>();
  const listenersOf = <T>(map: Map<string, Set<T>>, type: string): Set<T> => {
    let set = map.get(type);
    if (set === undefined) {
      set = new Set();
      map.set(type, set);
    }
    return set;
  };
  const doc = {
    visibilityState: 'visible',
    addEventListener(type: 'visibilitychange', listener: () => void) {
      listenersOf(plainListeners, type).add(listener);
    },
    removeEventListener(type: 'visibilitychange', listener: () => void) {
      listenersOf(plainListeners, type).delete(listener);
    },
  };
  const target: KeyboardTarget = {
    addEventListener(type: string, listener: (event: KeyEventLike) => void) {
      listenersOf(type === 'blur' ? plainListeners : keyListeners, type).add(
        listener,
      );
    },
    removeEventListener(type: string, listener: (event: KeyEventLike) => void) {
      listenersOf(type === 'blur' ? plainListeners : keyListeners, type).delete(
        listener,
      );
    },
    document: doc,
  };
  const key = (type: 'keydown' | 'keyup', code: string, repeat = false) => {
    const event = {
      code,
      repeat,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    for (const listener of listenersOf(keyListeners, type)) listener(event);
    return event;
  };
  const fire = (type: 'blur' | 'visibilitychange') => {
    for (const listener of listenersOf(plainListeners, type)) listener();
  };
  const count = () =>
    [...keyListeners.values(), ...plainListeners.values()].reduce(
      (n, set) => n + set.size,
      0,
    );
  return { target, doc, key, fire, count };
}

describe('attachKeyboard', () => {
  it('forwards primary intents and prevents default on Space and ArrowUp only', () => {
    const fake = fakeTarget();
    const intents: Intent[] = [];
    attachKeyboard(fake.target, createKeyboard(), (i) => intents.push(i));

    expect(fake.key('keydown', 'Space').defaultPrevented).toBe(true);
    // Held: the reducer returns null, but scrolling is still prevented.
    expect(fake.key('keydown', 'Space', true).defaultPrevented).toBe(true);
    expect(fake.key('keyup', 'Space').defaultPrevented).toBe(true);
    expect(fake.key('keydown', 'ArrowUp').defaultPrevented).toBe(true);
    expect(fake.key('keyup', 'ArrowUp').defaultPrevented).toBe(true);
    expect(fake.key('keydown', 'KeyA').defaultPrevented).toBe(false);
    expect(fake.key('keyup', 'KeyA').defaultPrevented).toBe(false);

    expect(intents).toEqual(['primary', 'primary']);
  });

  it('releases held keys on blur', () => {
    const fake = fakeTarget();
    const intents: Intent[] = [];
    attachKeyboard(fake.target, createKeyboard(), (i) => intents.push(i));

    fake.key('keydown', 'Space');
    fake.fire('blur'); // the keyup is lost while unfocused
    fake.key('keydown', 'Space');

    expect(intents).toEqual(['primary', 'primary']);
  });

  it('releases held keys when the page becomes hidden, not when visible', () => {
    const fake = fakeTarget();
    const intents: Intent[] = [];
    attachKeyboard(fake.target, createKeyboard(), (i) => intents.push(i));

    fake.key('keydown', 'Space');
    fake.fire('visibilitychange'); // still visible: Space stays held
    fake.key('keydown', 'Space');
    expect(intents).toEqual(['primary']);

    fake.doc.visibilityState = 'hidden';
    fake.fire('visibilitychange');
    fake.key('keydown', 'Space');
    expect(intents).toEqual(['primary', 'primary']);
  });

  it('dispose() removes all four listeners', () => {
    const fake = fakeTarget();
    const handle = attachKeyboard(fake.target, createKeyboard(), () => {
      /* unused */
    });
    expect(fake.count()).toBe(4);
    handle.dispose();
    expect(fake.count()).toBe(0);
  });
});

describe('wireKeyboardToGame', () => {
  it('does not leak handlers on restart: one press gives one dispatch after ten restarts', () => {
    const fake = fakeTarget();
    const restartHandlers: (() => void)[] = [];
    const fakeGame = {
      dispatch: vi.fn(),
      on: (type: string, handler: () => void) => {
        if (type === 'restart') restartHandlers.push(handler);
        return () => undefined;
      },
    };

    wireKeyboardToGame(fake.target, createKeyboard(), fakeGame);

    fake.key('keydown', 'Space');
    expect(fakeGame.dispatch).toHaveBeenCalledTimes(1);
    expect(fakeGame.dispatch).toHaveBeenCalledWith('primary');

    fakeGame.dispatch.mockClear();
    for (let i = 0; i < 10; i += 1) {
      for (const handler of restartHandlers) handler();
    }
    fake.key('keydown', 'Space');

    expect(fakeGame.dispatch).toHaveBeenCalledTimes(1);
  });
});
