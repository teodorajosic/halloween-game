// Acceptance tests: drive createGame against the functional spec, one describe
// per spec section (technical considerations 4.1 and 4.2).

import { describe, expect, it } from 'vitest';
import { createBus } from '../src/events.js';
import { speedAt } from '../src/obstacles.js';
import { Sprites } from '../src/sprites.js';
import { createMemoryStore } from '../src/store.js';
import {
  BLINK_SCHEDULE,
  CANVAS,
  DINO_X,
  FIRST_ARRIVAL_TICKS,
  FRAME_CLAMP_MS,
  GROUND_Y,
  JUMP_DURATION_TICKS,
  JUMP_HEIGHT_PX,
  MAX_GAP_FACTOR,
  MAX_GROUP_SIZE,
  MAX_SCORE,
  MAX_SPEED,
  MAX_SPEED_AT_TICK,
  MILESTONE_EVERY,
  RUN_FRAME_TICKS,
  SCORE_PER_SECOND,
  START_SPEED,
  STEP_MS,
  minGapPx,
} from '../src/tuning.js';
import type { Game, GameEvent, GameState, Obstacle } from '../src/types.js';
import { collect, makeGame, pressPrimary, runUntil } from './helpers.js';

const ALL_EVENT_TYPES: readonly GameEvent['type'][] = [
  'start',
  'tick',
  'jump',
  'land',
  'spawn',
  'milestone',
  'speedChange',
  'die',
  'restart',
];

describe('2.1 start screen', () => {
  it('opens idle with no cacti, score 0 and the start hint', () => {
    const { game } = makeGame();
    const s = game.state();

    expect(s.phase).toBe('idle');
    expect(s.tick).toBe(0);
    expect(s.score).toBe(0);
    expect(s.obstacles).toEqual([]);
    expect(s.spawnLog).toEqual([]);
    expect(s.hud).toEqual({
      hint: 'start',
      gameOver: false,
      blinkVisible: true,
    });
  });

  it('shows the dinosaur standing on the ground at the left', () => {
    const { game } = makeGame();
    const { dino } = game.state();
    const sprite = Sprites.dinoStand;

    expect(dino).toMatchObject({
      x: DINO_X,
      y: GROUND_Y - sprite.height,
      width: sprite.width,
      height: sprite.height,
      onGround: true,
      pose: 'stand',
      frame: 0,
    });
    expect(dino.y + dino.height).toBe(GROUND_Y);
    expect(dino.hitbox).toEqual({
      x: DINO_X + sprite.hitbox.x,
      y: dino.y + sprite.hitbox.y,
      width: sprite.hitbox.width,
      height: sprite.hitbox.height,
    });
  });

  it('shows HI from the store when a best score was recorded', () => {
    const { game, store } = makeGame(undefined, { hi: 123 });

    expect(game.state().hi).toBe(123);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('shows no HI when no best score was ever recorded', () => {
    const { game } = makeGame();

    expect(game.state().hi).toBeNull();
  });

  it('does not draw a seed at construction or while idle', () => {
    const { game, randomSeed } = makeGame();
    game.tick(120);

    expect(randomSeed).not.toHaveBeenCalled();
    expect(game.state().seed).toBeNull();
  });

  it('reports the URL seed while idle on a seeded page', () => {
    const { game, randomSeed } = makeGame(42);

    expect(game.state().seed).toBe(42);
    expect(randomSeed).not.toHaveBeenCalled();
  });

  it('stays unchanged and silent while idle without input', () => {
    const { game } = makeGame(7, { hi: 5 });
    const before = game.state();
    const events = ALL_EVENT_TYPES.map((type) => collect(game, type));

    game.tick(600);

    expect(game.state()).toEqual(before);
    expect(events.flat()).toEqual([]);
  });

  it('queues a dispatched intent without applying it before the next step', () => {
    const { game } = makeGame();
    const before = game.state();

    game.dispatch('primary');

    expect(game.state()).toEqual(before);
  });
});

describe('2.1 starting a run', () => {
  it('starts on the step that consumes primary, moving nothing (tick 0, START_SPEED)', () => {
    const { game, randomSeed } = makeGame(undefined, { seeds: [77] });
    const before = game.state();
    const starts = collect(game, 'start');
    const ticks = collect(game, 'tick');

    pressPrimary(game);
    const s = game.state();

    expect(randomSeed).toHaveBeenCalledTimes(1);
    expect(starts).toEqual([{ type: 'start', seed: 77 }]);
    expect(ticks).toEqual([]);
    expect(s.phase).toBe('running');
    expect(s.tick).toBe(0);
    expect(s.seed).toBe(77);
    expect(s.speed).toBe(START_SPEED);
    expect(s.score).toBe(0);
    expect(s.obstacles).toEqual([]);
    expect(s.hud).toEqual({ hint: null, gameOver: false, blinkVisible: true });
    expect(s.dino).toMatchObject({
      x: before.dino.x,
      y: before.dino.y,
      onGround: true,
      pose: 'run',
      frame: 0,
    });
  });

  it('uses the URL seed on a seeded page without calling randomSeed', () => {
    const { game, randomSeed } = makeGame(42);
    const starts = collect(game, 'start');

    pressPrimary(game);

    expect(randomSeed).not.toHaveBeenCalled();
    expect(starts).toEqual([{ type: 'start', seed: 42 }]);
    expect(game.state().seed).toBe(42);
  });

  it('scores after 60 more ticks, the next step being running tick 1', () => {
    const { game } = makeGame();
    const ticks = collect(game, 'tick');
    pressPrimary(game);

    game.tick();
    expect(game.state().tick).toBe(1);

    game.tick(59);
    const s = game.state();

    expect(s.tick).toBe(60);
    expect(s.score).toBeGreaterThan(0);
    expect(ticks.map((e) => e.tick)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
  });

  it('consumes at most one primary per step and drops the rest', () => {
    const { game, randomSeed } = makeGame();
    const starts = collect(game, 'start');

    game.dispatch('primary');
    game.dispatch('primary');
    game.tick();
    game.tick();

    expect(randomSeed).toHaveBeenCalledTimes(1);
    expect(starts).toHaveLength(1);
    expect(game.state().tick).toBe(1);
  });
});

/** Starts a run, runs `lead` ticks on the ground, then presses primary to jump. */
function startAndJump(seed: number, lead = 10): Game {
  const { game } = makeGame(seed);
  pressPrimary(game);
  game.tick(lead);
  return game;
}

/** Records `[tick, type]` for every jump, land and tick event, in order. */
function recordTimeline(game: Game): [number, GameEvent['type']][] {
  const timeline: [number, GameEvent['type']][] = [];
  for (const type of ['jump', 'land', 'tick'] as const) {
    game.on(type, () => {
      timeline.push([game.view().tick, type]);
    });
  }
  return timeline;
}

describe('2.2 jumping', () => {
  const restY = GROUND_Y - Sprites.dinoStand.height;

  it('lands JUMP_DURATION_TICKS ± 1 ticks after the jump', () => {
    const game = startAndJump(1);
    const timeline = recordTimeline(game);

    pressPrimary(game);
    runUntil(game, (s) => s.dino.onGround, JUMP_DURATION_TICKS * 2);

    const jumps = timeline.filter(([, type]) => type === 'jump');
    const lands = timeline.filter(([, type]) => type === 'land');
    expect(jumps).toHaveLength(1);
    expect(lands).toHaveLength(1);
    const airtime = (lands[0]?.[0] ?? 0) - (jumps[0]?.[0] ?? 0);
    expect(Math.abs(airtime - JUMP_DURATION_TICKS)).toBeLessThanOrEqual(1);
    expect(game.state().dino.y).toBe(restY);
  });

  it('emits jump and land before tick within their steps', () => {
    const game = startAndJump(1);
    const timeline = recordTimeline(game);

    pressPrimary(game);
    runUntil(game, (s) => s.dino.onGround, JUMP_DURATION_TICKS * 2);

    const jumpAt = timeline.findIndex(([, type]) => type === 'jump');
    const landAt = timeline.findIndex(([, type]) => type === 'land');
    expect(timeline[jumpAt + 1]).toEqual([timeline[jumpAt]?.[0], 'tick']);
    expect(timeline[landAt + 1]).toEqual([timeline[landAt]?.[0], 'tick']);
  });

  it('peaks about JUMP_HEIGHT_PX above the ground', () => {
    const game = startAndJump(1);
    pressPrimary(game);
    let apex = game.view().dino.y;
    while (!game.view().dino.onGround) {
      game.tick();
      apex = Math.min(apex, game.view().dino.y);
    }

    expect(restY - apex).toBeCloseTo(JUMP_HEIGHT_PX, 3);
  });

  it('ignores primary while airborne: no second jump, identical trajectory', () => {
    const pressed = startAndJump(5);
    const control = startAndJump(5);
    const jumps = collect(pressed, 'jump');
    const lands = collect(pressed, 'land');
    pressPrimary(pressed);
    pressPrimary(control);

    const pressedYs: number[] = [];
    const controlYs: number[] = [];
    for (let i = 0; i < JUMP_DURATION_TICKS + 10; i += 1) {
      // Press on every airborne tick of the pressed run, early and late.
      if (!pressed.view().dino.onGround) {
        pressed.dispatch('primary');
      }
      pressed.tick();
      control.tick();
      pressedYs.push(pressed.view().dino.y);
      controlYs.push(control.view().dino.y);
    }

    expect(jumps).toHaveLength(1);
    expect(lands).toHaveLength(1);
    expect(pressedYs).toEqual(controlYs);
    expect(pressed.state()).toEqual(control.state());
  });

  it('is airborne, still running, with a constant run frame while in the air', () => {
    const game = startAndJump(1, RUN_FRAME_TICKS - 1);
    pressPrimary(game);
    const takeOff = game.state().dino;

    expect(takeOff.onGround).toBe(false);
    expect(takeOff.y).toBeLessThan(restY);
    let airborneTicks = 0;
    while (!game.view().dino.onGround) {
      const { dino } = game.view();
      expect(dino.pose).toBe('run');
      expect(dino.frame).toBe(takeOff.frame);
      airborneTicks += 1;
      game.tick();
    }
    expect(airborneTicks).toBeGreaterThan(RUN_FRAME_TICKS);

    // Back on the ground, the legs alternate again.
    const frames = new Set<number>();
    for (let i = 0; i < RUN_FRAME_TICKS * 2; i += 1) {
      game.tick();
      frames.add(game.view().dino.frame);
    }
    expect(frames).toEqual(new Set([0, 1]));
  });

  it('jumps again once landed', () => {
    const game = startAndJump(1);
    const jumps = collect(game, 'jump');
    pressPrimary(game);
    runUntil(game, (s) => s.dino.onGround, JUMP_DURATION_TICKS * 2);

    pressPrimary(game);

    expect(jumps).toHaveLength(2);
    expect(game.state().dino.onGround).toBe(false);
  });

  it('drops leftover queued intents after consuming one per step', () => {
    const { game } = makeGame(undefined, { deps: { collisions: false } });
    const jumps = collect(game, 'jump');

    game.dispatch('primary');
    game.dispatch('primary');
    game.tick(1);

    const state = game.state();
    expect(state.phase).toBe('running');
    expect(state.tick).toBe(1);
    expect(state.dino.onGround).toBe(true);
    expect(jumps).toHaveLength(0);
  });
});

describe('2.2 legs alternate', () => {
  it('toggles dino.frame every RUN_FRAME_TICKS while running on the ground', () => {
    const { game } = makeGame();
    pressPrimary(game);

    const frames: number[] = [];
    for (let i = 0; i < RUN_FRAME_TICKS * 6; i += 1) {
      game.tick();
      const { dino, tick } = game.view();
      expect(dino.onGround).toBe(true);
      expect(dino.pose).toBe('run');
      frames.push(dino.frame);
      expect(dino.frame).toBe(Math.floor(tick / RUN_FRAME_TICKS) % 2);
    }
    expect(new Set(frames)).toEqual(new Set([0, 1]));
  });
});

describe('2.3 cacti', () => {
  /** A started long run (collisions off) for `seed`. */
  function startLongRun(seed: number): Game {
    const { game } = makeGame(seed, { deps: { collisions: false } });
    pressPrimary(game);
    return game;
  }

  /** Architecture section 3: the first tick where an obstacle reaches the dinosaur. */
  function reachesDino(state: GameState): boolean {
    const reach = state.dino.hitbox.x + state.dino.hitbox.width;
    return state.obstacles.some((o) => o.hitbox.x <= reach);
  }

  it('brings the first cactus to the dinosaur within FIRST_ARRIVAL_TICKS for seeds 0 to 199', () => {
    const [from, to] = FIRST_ARRIVAL_TICKS;
    for (let seed = 0; seed < 200; seed += 1) {
      const game = startLongRun(seed);
      runUntil(game, reachesDino, to + 1);
      const arrival = game.state().tick;
      expect(arrival, `seed ${String(seed)}`).toBeGreaterThanOrEqual(from);
      expect(arrival, `seed ${String(seed)}`).toBeLessThanOrEqual(to);
    }
  });

  it('brings the first cactus in from the right edge for seeds 0 to 199', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const game = startLongRun(seed);
      runUntil(game, (s) => s.obstacles.length > 0, FIRST_ARRIVAL_TICKS[1]);
      const { obstacles, speed } = game.state();
      const lead = obstacles[0];
      expect(lead, `seed ${String(seed)}`).toBeDefined();
      // Same rule as every later group: one step earlier its leading edge
      // was at or beyond the right edge, so it never pops up mid-screen.
      expect(
        (lead?.x ?? 0) + speed,
        `seed ${String(seed)}`,
      ).toBeGreaterThanOrEqual(CANVAS.width);
    }
  });

  it('spawns both a small and a large cactus by tick 1200 for seeds 0 to 199', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const game = startLongRun(seed);
      game.tick(1200);
      const kinds = new Set(game.view().spawnLog.map((entry) => entry.kind));
      expect([...kinds].sort(), `seed ${String(seed)}`).toEqual([
        'large',
        'small',
      ]);
    }
  });

  it('keeps every gap between consecutive groups in [minGapPx, MAX_GAP_FACTOR * minGapPx] at spawn time, at every pace', () => {
    for (const seed of [1, 42, 2024]) {
      const game = startLongRun(seed);
      const spawns = collect(game, 'spawn');
      let trailing: number | null = null;
      let gaps = 0;
      let gapsAtMax = 0;
      // Past MAX_SPEED_AT_TICK, so the bound is checked while the pace ramps
      // and at MAX_SPEED.
      for (let t = 0; t < MAX_SPEED_AT_TICK + 1200; t += 1) {
        const seen = spawns.length;
        game.tick();
        const { speed } = game.view();
        if (trailing !== null) {
          trailing -= speed;
        }
        const spawned = spawns.slice(seen).map((e) => e.obstacle);
        const lead = spawned[0];
        if (lead === undefined) {
          continue;
        }
        if (trailing !== null) {
          const gap = lead.x - trailing;
          expect(gap).toBeGreaterThanOrEqual(minGapPx(speed));
          expect(gap).toBeLessThanOrEqual(MAX_GAP_FACTOR * minGapPx(speed));
          gaps += 1;
          if (speed === MAX_SPEED) {
            gapsAtMax += 1;
          }
        }
        trailing = Math.max(...spawned.map((o) => o.x + o.width));
      }
      expect(gaps).toBeGreaterThan(10);
      expect(gapsAtMax).toBeGreaterThan(5);
    }
  });

  it('spawns groups of at most MAX_GROUP_SIZE contiguous cacti sharing one group', () => {
    const game = startLongRun(7);
    const spawns = collect(game, 'spawn');
    game.tick(6000);
    const byGroup = new Map<number, Obstacle[]>();
    for (const { obstacle } of spawns) {
      byGroup.set(obstacle.group, [
        ...(byGroup.get(obstacle.group) ?? []),
        obstacle,
      ]);
    }
    expect([...byGroup.keys()]).toEqual([...byGroup.keys()].map((_, i) => i));
    const sizes = new Set<number>();
    for (const group of byGroup.values()) {
      expect(group.length).toBeLessThanOrEqual(MAX_GROUP_SIZE);
      sizes.add(group.length);
      group.slice(1).forEach((obstacle, i) => {
        const previous = group[i];
        expect(previous).toBeDefined();
        expect(obstacle.x).toBe((previous?.x ?? 0) + (previous?.width ?? 0));
        expect(obstacle.kind).toBe('small');
      });
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('logs one spawnLog entry and emits one spawn event per obstacle, before tick', () => {
    const game = startLongRun(11);
    const order: string[] = [];
    const spawns = collect(game, 'spawn');
    const spawnTicks: number[] = [];
    game.on('spawn', () => {
      order.push('spawn');
      spawnTicks.push(game.view().tick);
    });
    game.on('tick', () => order.push('tick'));
    game.on('jump', () => order.push('jump'));
    game.on('land', () => order.push('land'));
    for (let t = 0; t < 2000; t += 1) {
      if (t % 50 === 0) {
        game.dispatch('primary');
      }
      game.tick();
    }
    const state = game.state();
    expect(state.spawnLog).toEqual(
      spawns.map(({ obstacle }, i) => ({
        kind: obstacle.kind,
        group: obstacle.group,
        tick: spawnTicks[i],
      })),
    );
    expect(spawns.map(({ obstacle }) => obstacle.id)).toEqual(
      spawns.map((_, i) => i),
    );
    expect(spawns[0]?.obstacle.id).toBe(0);
    expect(spawns[0]?.obstacle.group).toBe(0);
    // Within a step: jump, land, then spawn, then tick last.
    const steps = order
      .join(' ')
      .split('tick')
      .map((s) => s.trim().split(' ').filter(Boolean));
    for (const events of steps) {
      const rank = events.map((e) => ['jump', 'land', 'spawn'].indexOf(e));
      expect(rank).toEqual([...rank].sort((a, b) => a - b));
    }
    expect(order.filter((e) => e === 'spawn')).toHaveLength(spawns.length);
  });

  it('stands cacti on the ground with absolute hitboxes', () => {
    const game = startLongRun(3);
    const spawns = collect(game, 'spawn');
    game.tick(1200);
    expect(spawns.length).toBeGreaterThan(0);
    for (const { obstacle } of spawns) {
      const sprite =
        obstacle.kind === 'small' ? Sprites.cactusSmall : Sprites.cactusLarge;
      expect(obstacle.y + obstacle.height).toBe(GROUND_Y);
      expect(obstacle.hitbox).toEqual({
        x: obstacle.x + sprite.hitbox.x,
        y: obstacle.y + sprite.hitbox.y,
        width: sprite.hitbox.width,
        height: sprite.hitbox.height,
      });
    }
  });

  it('removes cacti past the left edge and keeps ids strictly increasing', () => {
    const game = startLongRun(5);
    let lastSeenMaxId = -1;
    let removed = 0;
    let previousIds: number[] = [];
    for (let t = 0; t < 3000; t += 1) {
      game.tick();
      const { obstacles } = game.view();
      const ids = obstacles.map((o) => o.id);
      for (const obstacle of obstacles) {
        expect(obstacle.x + obstacle.width).toBeGreaterThanOrEqual(0);
      }
      ids.slice(1).forEach((id, i) => {
        expect(id).toBeGreaterThan(ids[i] ?? Number.POSITIVE_INFINITY);
      });
      // A removed id never comes back.
      for (const id of previousIds) {
        if (!ids.includes(id)) {
          removed += 1;
          expect(id).toBeLessThanOrEqual(lastSeenMaxId);
        }
      }
      for (const id of ids) {
        if (!previousIds.includes(id)) {
          expect(id).toBeGreaterThan(lastSeenMaxId);
        }
      }
      lastSeenMaxId = Math.max(lastSeenMaxId, ...ids);
      previousIds = ids;
    }
    expect(removed).toBeGreaterThan(10);
  });
});

describe('2.4 pace increases during a run', () => {
  /** A started long run (collisions off) for `seed`. */
  function startLongRun(seed: number): Game {
    const { game } = makeGame(seed, { deps: { collisions: false } });
    pressPrimary(game);
    return game;
  }

  /** Airborne ticks of one jump started on the next step. */
  function jumpAirtime(game: Game): number {
    const jumpTick = game.view().tick + 1;
    const lands = collect(game, 'land');
    pressPrimary(game);
    runUntil(game, () => lands.length > 0, JUMP_DURATION_TICKS * 2);
    return game.view().tick - jumpTick;
  }

  it('starts at START_SPEED, is about 1.3x at 30 s and MAX_SPEED from 90 s on', () => {
    const game = startLongRun(7);
    expect(game.state().speed).toBe(START_SPEED);
    game.tick(1800);
    const at30s = game.state();
    expect(at30s.tick).toBe(1800);
    expect(at30s.speed).toBe(speedAt(1800));
    expect(Math.abs(at30s.speed / START_SPEED - 1.3)).toBeLessThanOrEqual(0.05);
    game.tick(MAX_SPEED_AT_TICK - 1800);
    expect(game.state().speed).toBe(MAX_SPEED);
    for (let i = 0; i < 1800; i += 1) {
      game.tick();
      expect(game.view().speed).toBe(MAX_SPEED);
    }
  });

  it('moves cacti faster at 30 s than in the first 5 s', () => {
    const game = startLongRun(7);
    game.tick(300);
    const early = game.state().speed;
    game.tick(1500);
    expect(game.state().speed).toBeGreaterThan(early * 1.2);
  });

  it('emits speedChange exactly at each 0.1x multiple of START_SPEED: 10 events over the ramp', () => {
    const game = startLongRun(7);
    const changes: [number, number][] = [];
    game.on('speedChange', ({ speed }) => {
      changes.push([game.view().tick, speed]);
    });
    game.tick(MAX_SPEED_AT_TICK + 1800);
    // 1.0x to 2.0x crosses 1.1x, 1.2x, ... 2.0x.
    expect(changes).toHaveLength(10);
    // speedAt is linear, so 1.1x, 1.2x, ... fall exactly on multiples of
    // MAX_SPEED_AT_TICK / 10, and each event fires on that very tick.
    changes.forEach(([tick, speed], i) => {
      expect(tick).toBe((MAX_SPEED_AT_TICK / 10) * (i + 1));
      expect(speed).toBe(speedAt(tick));
      expect(speed).toBeCloseTo(START_SPEED * (1.1 + i / 10), 9);
    });
    expect(changes.at(-1)?.[1]).toBe(MAX_SPEED);
  });

  it('scrolls the world by exactly the per-step speed, the same amount the cacti move', () => {
    const game = startLongRun(7);
    expect(game.state().scrollX).toBe(0);
    let checkedSteps = 0;
    for (let i = 0; i < MAX_SPEED_AT_TICK + 600; i++) {
      const before = game.state();
      game.tick();
      const after = game.state();
      expect(after.scrollX - before.scrollX).toBeCloseTo(after.speed, 9);
      for (const o of after.obstacles) {
        const prev = before.obstacles.find((p) => p.id === o.id);
        if (prev === undefined) continue;
        expect(prev.x - o.x).toBeCloseTo(after.scrollX - before.scrollX, 9);
        checkedSteps++;
      }
    }
    expect(checkedSteps).toBeGreaterThan(1000);
  });

  it('emits speedChange first in its step, before jump and tick', () => {
    const game = startLongRun(7);
    const firstChange = MAX_SPEED_AT_TICK / 10;
    game.tick(firstChange - 1);
    const order: GameEvent['type'][] = [];
    for (const type of ALL_EVENT_TYPES) {
      game.on(type, (event) => order.push(event.type));
    }
    pressPrimary(game);
    expect(game.view().tick).toBe(firstChange);
    expect(order[0]).toBe('speedChange');
    expect(order.indexOf('jump')).toBe(1);
    expect(order.at(-1)).toBe('tick');
  });

  it('keeps the jump the same length early in a run and after MAX_SPEED_AT_TICK', () => {
    const game = startLongRun(11);
    game.tick(10);
    const early = jumpAirtime(game);
    game.tick(MAX_SPEED_AT_TICK);
    expect(game.state().speed).toBe(MAX_SPEED);
    const late = jumpAirtime(game);
    expect(late).toBe(early);
    expect(Math.abs(early - JUMP_DURATION_TICKS)).toBeLessThanOrEqual(1);
  });
});

describe('2.5 crashing and the game-over screen', () => {
  const SEED = 42;
  /** Far beyond the first arrival, so a run without jumping must have died. */
  const MAX_TICKS_TO_DIE = FIRST_ARRIVAL_TICKS[1] * 4;

  /** Records every event of every type, in emission order. */
  function recordAll(game: Game): GameEvent[] {
    const events: GameEvent[] = [];
    for (const type of ALL_EVENT_TYPES) {
      game.on(type, (event) => {
        events.push(event);
      });
    }
    return events;
  }

  /**
   * Starts a seeded run and steps it, without jumping, until `die` is emitted.
   * Returns every event since the start; the last step is the dying one.
   */
  function runUntilDeath(): { game: Game; events: GameEvent[] } {
    const { game } = makeGame(SEED, { hi: 7 });
    pressPrimary(game);
    const events = recordAll(game);
    const deaths = collect(game, 'die');
    for (let i = 0; i < MAX_TICKS_TO_DIE && deaths.length === 0; i += 1) {
      game.tick();
    }
    expect(deaths).toHaveLength(1);
    return { game, events };
  }

  it('ends the run on the same tick as the collision, with the hit pose and game-over HUD', () => {
    const { game, events } = runUntilDeath();
    const s = game.state();

    expect(s.phase).toBe('dead');
    expect(s.dino.pose).toBe('hit');
    expect(s.hud).toEqual({
      hint: 'restart',
      gameOver: true,
      blinkVisible: true,
    });
    // The dying step still emits `tick`, after `die`, and the two end the step.
    expect(events.slice(-2)).toEqual([
      // The final score beats hi 7, so it is the new high score (2.6).
      { type: 'die', score: s.score, highScore: s.score, isNewHighScore: true },
      { type: 'tick', tick: s.tick },
    ]);
  });

  it('stays frozen and silent for 600 further ticks', () => {
    const { game } = runUntilDeath();
    const before = game.state();
    const events = recordAll(game);

    game.tick(600);

    expect(game.state()).toEqual(before);
    expect(events).toEqual([]);
  });

  it('keeps running past the dying tick when collisions are off', () => {
    const { game: dying } = runUntilDeath();
    const deathTick = dying.state().tick;
    const { game } = makeGame(SEED, { deps: { collisions: false } });
    const deaths = collect(game, 'die');
    pressPrimary(game);

    game.tick(deathTick + 60);

    expect(deaths).toEqual([]);
    expect(game.state().phase).toBe('running');
    expect(game.state().tick).toBe(deathTick + 60);
  });
});

describe('2.7 restarting', () => {
  const SEED = 42;
  /** Far beyond the first arrival, so a run without jumping must have died. */
  const MAX_TICKS_TO_DIE = FIRST_ARRIVAL_TICKS[1] * 4;

  /** Steps a running game, without jumping, until it is dead; returns the dying tick. */
  function dieWithoutJumping(game: Game): number {
    runUntil(game, (s) => s.phase === 'dead', MAX_TICKS_TO_DIE);
    return game.state().tick;
  }

  /** A seeded game (collisions on, hi 7) started and run into the first cactus. */
  function deadGame(): ReturnType<typeof makeGame> {
    const made = makeGame(SEED, { hi: 7 });
    pressPrimary(made.game);
    dieWithoutJumping(made.game);
    return made;
  }

  /** Records every event of every type, in emission order. */
  function recordAll(game: Game): GameEvent[] {
    const events: GameEvent[] = [];
    for (const type of ALL_EVENT_TYPES) {
      game.on(type, (event) => {
        events.push(event);
      });
    }
    return events;
  }

  it('restarts a fully fresh run on the step that consumes primary in dead', () => {
    const { game } = makeGame(undefined, { hi: 7, seeds: [5, 9] });
    pressPrimary(game);
    dieWithoutJumping(game);
    const dead = game.state();
    // The dying run had moved, scored and spawned: the reset must undo all of it.
    expect(dead.obstacles.length).toBeGreaterThan(0);
    expect(dead.spawnLog.length).toBeGreaterThan(0);
    expect(dead.score).toBeGreaterThan(0);
    // It also beat hi 7, which is the one thing a restart keeps.
    expect(dead.hi).toBe(dead.score);
    const events = recordAll(game);

    game.dispatch('primary');
    // Restart applies on the next step after dispatch (at most one step,
    // far inside the half second of spec 2.7).
    game.tick();

    const s = game.state();
    expect(s.phase).toBe('running');
    expect(s.seed).toBe(9);
    expect(s.score).toBe(0);
    expect(s.obstacles).toEqual([]);
    expect(s.spawnLog).toEqual([]);
    expect(s.hi).toBe(dead.hi);
    expect(s.dino.onGround).toBe(true);
    expect(s.dino.y + s.dino.height).toBe(GROUND_Y);
    expect(s.dino.pose).toBe('run');
    expect(s.hud).toEqual({ hint: null, gameOver: false, blinkVisible: true });
    expect(events).toEqual([{ type: 'restart', seed: 9 }]);
  });

  it('draws exactly one new seed per restart', () => {
    const { game, randomSeed } = makeGame(undefined, { seeds: [5, 9] });
    pressPrimary(game);
    dieWithoutJumping(game);
    expect(randomSeed).toHaveBeenCalledTimes(1);

    pressPrimary(game);

    expect(randomSeed).toHaveBeenCalledTimes(2);
  });

  it('leaves the game-over screen unchanged without a primary intent', () => {
    // A non-primary key never reaches the game: the keyboard reducer returns
    // null for it (tests/input.test.ts), so nothing is dispatched.
    const { game } = deadGame();
    const before = game.state();
    const events = recordAll(game);

    game.tick(30);

    expect(game.state()).toEqual(before);
    expect(events).toEqual([]);
  });

  it('restarts with tick 0 and START_SPEED regardless of the dying run pace', () => {
    const { game } = makeGame(undefined, { seeds: [5, 9] });
    pressPrimary(game);
    dieWithoutJumping(game);
    const pre = game.state();
    expect(pre.tick).toBeGreaterThan(0);
    expect(pre.speed).toBeGreaterThanOrEqual(START_SPEED);

    game.dispatch('primary');
    game.tick(1);

    const state = game.state();
    expect(state.tick).toBe(0);
    expect(state.speed).toBe(START_SPEED);
  });
});

describe('2.6 score rate', () => {
  it('scores SCORE_PER_SECOND points per second of running at START_SPEED', () => {
    // Collisions off: ten seconds without jumping would otherwise end the run.
    const { game } = makeGame(undefined, { deps: { collisions: false } });
    pressPrimary(game);

    game.tick(60);
    expect(game.state().score).toBe(SCORE_PER_SECOND);

    // The pace ramps from tick 1 (2.4), and the score scales with it.
    game.tick(540);
    const s = game.state();
    let expected = 0;
    for (let t = 1; t <= 600; t += 1) {
      expected += ((SCORE_PER_SECOND / 60) * speedAt(t)) / START_SPEED;
    }
    expect(s.score).toBe(Math.floor(expected));
    expect(s.score).toBeGreaterThan(SCORE_PER_SECOND * 10);
    expect(Number.isInteger(s.score)).toBe(true);
    expect(s.speed).toBe(speedAt(600));
  });
});

describe('2.6 milestones and the score blink', () => {
  /** True when `elapsed` ticks since a milestone fall in a hidden BLINK_SCHEDULE range. */
  function isHiddenAt(elapsed: number): boolean {
    return BLINK_SCHEDULE.some(
      ([from, to]) => elapsed >= from && elapsed <= to,
    );
  }

  /** The tick right after the last hidden range: the blink is over by then. */
  const BLINK_END = Math.max(...BLINK_SCHEDULE.map(([, to]) => to)) + 1;

  it('emits milestone with each multiple of MILESTONE_EVERY: 100, then 200', () => {
    const { game } = makeGame(undefined, { deps: { collisions: false } });
    const milestones = collect(game, 'milestone');
    pressPrimary(game);

    runUntil(game, (s) => s.score >= 2 * MILESTONE_EVERY, 2000);

    expect(milestones).toEqual([
      { type: 'milestone', score: MILESTONE_EVERY },
      { type: 'milestone', score: 2 * MILESTONE_EVERY },
    ]);
  });

  it('emits milestone on the step the score reaches the multiple, after spawn and before tick', () => {
    const { game } = makeGame(undefined, { deps: { collisions: false } });
    pressPrimary(game);
    runUntil(game, (s) => s.score === MILESTONE_EVERY - 1, 2000);
    const types: GameEvent['type'][] = [];
    for (const type of ALL_EVENT_TYPES) {
      game.on(type, (event) => {
        types.push(event.type);
      });
    }

    runUntil(game, (s) => s.score === MILESTONE_EVERY, 20);

    expect(types.filter((t) => t === 'milestone')).toHaveLength(1);
    expect(types.indexOf('milestone')).toBe(types.length - 2);
  });

  it('hides the score on BLINK_SCHEDULE ticks after each milestone and shows it otherwise', () => {
    const { game } = makeGame(undefined, { deps: { collisions: false } });
    const milestoneTicks: number[] = [];
    game.on('milestone', () => {
      milestoneTicks.push(game.view().tick);
    });
    pressPrimary(game);

    let checked = 0;
    let hiddenTicks = 0;
    while (milestoneTicks.length < 3) {
      game.tick();
      const s = game.view();
      const last = milestoneTicks.at(-1);
      const shouldHide = last !== undefined && isHiddenAt(s.tick - last);
      expect(s.hud.blinkVisible, `tick ${String(s.tick)}`).toBe(!shouldHide);
      if (shouldHide) {
        hiddenTicks += 1;
      }
      checked += 1;
    }
    // Run on past the third milestone's whole blink.
    for (let i = 0; i < BLINK_END + 10; i += 1) {
      game.tick();
      const s = game.view();
      const last = milestoneTicks.at(-1) ?? 0;
      expect(s.hud.blinkVisible, `tick ${String(s.tick)}`).toBe(
        !isHiddenAt(s.tick - last),
      );
    }

    // Visible for the whole run up to the first milestone (about 570 ticks).
    expect(milestoneTicks[0]).toBeGreaterThan(BLINK_END);
    expect(checked).toBeGreaterThan(milestoneTicks[0] ?? 0);
    expect(hiddenTicks).toBeGreaterThan(0);
    expect(game.view().hud.blinkVisible).toBe(true);
  });

  it('keeps the score a whole number, capped at MAX_SCORE, over a run long enough to reach it', () => {
    // About 300,000 ticks at MAX_SPEED (83 minutes of play); runs in well under a second.
    const { game } = makeGame(undefined, { deps: { collisions: false } });
    const milestones = collect(game, 'milestone');
    pressPrimary(game);

    let previous = 0;
    let isWholeAndCapped = true;
    let isMonotonic = true;
    while (game.view().score < MAX_SCORE) {
      game.tick();
      const { score } = game.view();
      isWholeAndCapped &&= Number.isInteger(score) && score <= MAX_SCORE;
      isMonotonic &&= score >= previous;
      previous = score;
    }
    game.tick(600);

    expect(isWholeAndCapped).toBe(true);
    expect(isMonotonic).toBe(true);
    expect(game.state().score).toBe(MAX_SCORE);
    // Every multiple below the cap, once each, in order.
    const multiples = Math.floor(MAX_SCORE / MILESTONE_EVERY);
    expect(milestones).toHaveLength(multiples);
    expect(milestones.at(-1)?.score).toBe(multiples * MILESTONE_EVERY);
  });

  it('shows the final score on the game-over screen even when death falls inside a blink', () => {
    // Seed 258: a deterministic jumper clears every cactus until the first
    // milestone, then stops pressing; the next cactus kills the run a little
    // over 20 ticks later, inside the hidden range 20 to 29.
    const SEED = 258;
    const JUMP_LEAD_PX = 10 * START_SPEED;
    const { game } = makeGame(SEED);
    const milestones = collect(game, 'milestone');
    const deaths = collect(game, 'die');
    const milestoneTicks: number[] = [];
    game.on('milestone', () => {
      milestoneTicks.push(game.view().tick);
    });
    pressPrimary(game);

    while (game.view().phase === 'running') {
      const s = game.view();
      const reach = s.dino.hitbox.x + s.dino.hitbox.width;
      const isClose = s.obstacles.some(
        (o) => o.hitbox.x >= reach && o.hitbox.x - reach <= JUMP_LEAD_PX,
      );
      if (milestoneTicks.length === 0 && isClose && s.dino.onGround) {
        game.dispatch('primary');
      }
      game.tick();
    }

    const s = game.state();
    expect(milestones).toEqual([{ type: 'milestone', score: MILESTONE_EVERY }]);
    expect(deaths).toHaveLength(1);
    const [milestoneTick] = milestoneTicks;
    expect(milestoneTick).toBeDefined();
    // The death really is inside a hidden range, so a running HUD would hide the score.
    expect(isHiddenAt(s.tick - (milestoneTick ?? 0))).toBe(true);
    expect(s.phase).toBe('dead');
    expect(s.hud.blinkVisible).toBe(true);
  });
});

describe('2.6 high score', () => {
  const SEED = 42;
  /** Far beyond the first arrival, so a run without jumping must have died. */
  const MAX_TICKS_TO_DIE = FIRST_ARRIVAL_TICKS[1] * 4;

  /** A seeded game with `hi` recorded, started and run, without jumping, into the first cactus. */
  function dieOnce(hi: number | null): ReturnType<typeof makeGame> & {
    deaths: Extract<GameEvent, { type: 'die' }>[];
  } {
    const made = makeGame(SEED, { hi });
    const deaths = collect(made.game, 'die');
    pressPrimary(made.game);
    runUntil(made.game, (s) => s.phase === 'dead', MAX_TICKS_TO_DIE);
    expect(deaths).toHaveLength(1);
    return { ...made, deaths };
  }

  /** The score seed 42 dies with when it never jumps (well above 0). */
  function deathScore(): number {
    return dieOnce(null).game.state().score;
  }

  it('saves a beating score once, updates hi and reports it in die', () => {
    const { game, store, deaths } = dieOnce(7);
    const s = game.state();

    expect(s.score).toBeGreaterThan(7);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith(s.score);
    expect(s.hi).toBe(s.score);
    expect(deaths).toEqual([
      { type: 'die', score: s.score, highScore: s.hi, isNewHighScore: true },
    ]);
  });

  it('records the first best score when none was recorded (hi null)', () => {
    const { game, store, deaths } = dieOnce(null);
    const s = game.state();

    expect(s.score).toBeGreaterThan(0);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith(s.score);
    expect(s.hi).toBe(s.score);
    expect(deaths[0]?.isNewHighScore).toBe(true);
  });

  it('saves nothing and keeps hi when the score does not beat it', () => {
    const { game, store, deaths } = dieOnce(MAX_SCORE);
    const s = game.state();

    expect(store.save).not.toHaveBeenCalled();
    expect(s.hi).toBe(MAX_SCORE);
    expect(deaths).toEqual([
      {
        type: 'die',
        score: s.score,
        highScore: MAX_SCORE,
        isNewHighScore: false,
      },
    ]);
  });

  it('saves nothing when the score only equals hi', () => {
    const score = deathScore();
    const { game, store, deaths } = dieOnce(score);

    expect(game.state().score).toBe(score);
    expect(store.save).not.toHaveBeenCalled();
    expect(game.state().hi).toBe(score);
    expect(deaths[0]?.isNewHighScore).toBe(false);
  });

  it('keeps hi across a restart and saves again only for a better run', () => {
    const { game, store } = dieOnce(7);
    const hi = game.state().hi;

    pressPrimary(game);
    expect(game.state().hi).toBe(hi);
    // The same seed and the same (no) inputs give the same score: no new best.
    runUntil(game, (s) => s.phase === 'dead', MAX_TICKS_TO_DIE);

    expect(game.state().hi).toBe(hi);
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});

describe('2.8 replaying the same course', () => {
  const SEED = 42;
  const RUN_TICKS = 600;
  const LONG_RUN_TICKS = 3000;
  const SNAPSHOT_EVERY = 100;

  /** A seeded long run (collisions off), started and stepped `ticks` times. */
  function longRun(seed: number | undefined, ticks: number): Game {
    const { game } = makeGame(seed, { deps: { collisions: false } });
    pressPrimary(game);
    game.tick(ticks);
    return game;
  }

  /**
   * Plays a started run with collisions on until `ticks` or death, pressing
   * whenever a cactus is close ahead (a lead scaled to the current pace), so
   * the run survives long enough to log several spawns. Same seed and same
   * inputs give the same run; a different course may kill it earlier.
   */
  function playWithJumper(game: Game, ticks: number): GameState {
    const LEAD_TICKS = 10;
    while (game.view().tick < ticks && game.view().phase === 'running') {
      const s = game.view();
      const reach = s.dino.hitbox.x + s.dino.hitbox.width;
      const isClose = s.obstacles.some(
        (o) =>
          o.hitbox.x >= reach && o.hitbox.x - reach <= LEAD_TICKS * s.speed,
      );
      if (isClose && s.dino.onGround) {
        game.dispatch('primary');
      }
      game.tick();
    }
    return game.state();
  }

  it('logs the same spawnLog over 600 ticks in two games with the same seed', () => {
    const a = longRun(SEED, RUN_TICKS).state();
    const b = longRun(SEED, RUN_TICKS).state();

    expect(a.spawnLog.length).toBeGreaterThan(3);
    expect(b.spawnLog).toEqual(a.spawnLog);
  });

  it('deep-equals two same-seed games every 100 ticks up to 3000', () => {
    const a = makeGame(SEED, { deps: { collisions: false } }).game;
    const b = makeGame(SEED, { deps: { collisions: false } }).game;
    pressPrimary(a);
    pressPrimary(b);

    for (
      let tick = SNAPSHOT_EVERY;
      tick <= LONG_RUN_TICKS;
      tick += SNAPSHOT_EVERY
    ) {
      a.tick(SNAPSHOT_EVERY);
      b.tick(SNAPSHOT_EVERY);
      expect(a.state().tick).toBe(tick);
      expect(b.state(), `tick ${String(tick)}`).toEqual(a.state());
    }
  });

  it('never calls randomSeed when a seed is given, at start or restart', () => {
    const { game, randomSeed } = makeGame(SEED);
    const starts = collect(game, 'start');
    const restarts = collect(game, 'restart');

    pressPrimary(game);
    runUntil(game, (s) => s.phase === 'dead', FIRST_ARRIVAL_TICKS[1] * 4);
    pressPrimary(game);

    expect(starts).toEqual([{ type: 'start', seed: SEED }]);
    expect(restarts).toEqual([{ type: 'restart', seed: SEED }]);
    expect(game.state().seed).toBe(SEED);
    expect(randomSeed).not.toHaveBeenCalled();
  });

  it('presents a different course for a different seed', () => {
    const a = longRun(SEED, RUN_TICKS).state();
    const b = longRun(SEED + 1, RUN_TICKS).state();

    expect(b.seed).toBe(SEED + 1);
    expect(b.spawnLog).not.toEqual(a.spawnLog);
  });

  it('presents different courses on consecutive runs without a seed', () => {
    const { game, randomSeed } = makeGame(undefined, { seeds: [1, 2] });
    pressPrimary(game);
    const first = playWithJumper(game, RUN_TICKS);
    expect(first.seed).toBe(1);
    runUntil(game, (s) => s.phase === 'dead', RUN_TICKS * 4);

    pressPrimary(game);
    const second = playWithJumper(game, first.tick);

    expect(second.seed).toBe(2);
    expect(randomSeed).toHaveBeenCalledTimes(2);
    expect(second.spawnLog).not.toEqual(first.spawnLog);
  });

  it('changes nothing but the course: a seed equals the same randomSeed value', () => {
    const seeded = makeGame(SEED, { deps: { collisions: false } }).game;
    const unseeded = makeGame(undefined, {
      seeds: [SEED],
      deps: { collisions: false },
    }).game;
    const seededEvents = collect(seeded, 'spawn');
    const unseededEvents = collect(unseeded, 'spawn');
    pressPrimary(seeded);
    pressPrimary(unseeded);

    seeded.tick(RUN_TICKS);
    unseeded.tick(RUN_TICKS);

    expect(unseeded.state()).toEqual(seeded.state());
    expect(unseededEvents).toEqual(seededEvents);
  });
});

describe('2.9 frame accumulator', () => {
  it('records the first call and runs no step', () => {
    const { game } = makeGame();

    expect(game.frame(1234)).toBe(0);
  });

  it('runs one step per STEP_MS, carrying the remainder', () => {
    const { game } = makeGame();
    game.frame(0);

    expect(game.frame(STEP_MS)).toBe(1);
    expect(game.frame(STEP_MS * 1.5)).toBe(0);
    expect(game.frame(STEP_MS * 3)).toBe(2);
  });

  it('runs exactly 6 steps for a 10,000 ms gap (clamped to FRAME_CLAMP_MS)', () => {
    const { game } = makeGame();
    pressPrimary(game);
    game.frame(5000);

    const steps = game.frame(15000);

    expect(steps).toBe(Math.round(FRAME_CLAMP_MS / STEP_MS));
    expect(steps).toBe(6);
    expect(game.state().tick).toBe(6);
  });

  it('runs exactly 6 steps for one 100 ms frame', () => {
    const { game } = makeGame();
    game.frame(0);

    expect(game.frame(FRAME_CLAMP_MS)).toBe(6);
  });

  it('runs no step when the clock goes backwards', () => {
    const { game } = makeGame();
    pressPrimary(game);
    game.frame(5000);

    expect(game.frame(4000)).toBe(0);
    expect(game.state().tick).toBe(0);
  });

  it('counts idle steps, which change nothing', () => {
    const { game } = makeGame();
    const before = game.state();
    game.frame(0);

    expect(game.frame(FRAME_CLAMP_MS)).toBe(6);
    expect(game.state()).toEqual(before);
  });
});

describe('re-entrancy', () => {
  it('throws when tick() or frame() is called from a listener, but allows dispatch()', () => {
    const { game } = makeGame();
    const errors: unknown[] = [];
    game.on('start', () => {
      try {
        game.tick();
      } catch (error) {
        errors.push(error);
      }
      try {
        game.frame(0);
      } catch (error) {
        errors.push(error);
      }
      game.dispatch('primary');
    });

    pressPrimary(game);

    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(
      /game\.tick\(\) cannot be called from an event listener/,
    );
    expect(String(errors[1])).toMatch(
      /game\.frame\(\) cannot be called from an event listener/,
    );
    expect(game.state().tick).toBe(0);
    // The guard resets after the step: ticking again works.
    game.tick();
    expect(game.state().tick).toBe(1);
  });

  it('lets a listener see the committed post-step state', () => {
    const { game } = makeGame();
    const seen: number[] = [];
    game.on('tick', () => {
      seen.push(game.state().tick);
    });
    pressPrimary(game);

    game.tick(3);

    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('createGame surface', () => {
  it('returns a plain, JSON-serialisable deep copy from state()', () => {
    const { game } = makeGame();
    const a = game.state();
    const b = game.state();

    expect(a).not.toBe(b);
    expect(a.dino).not.toBe(b.dino);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('projects the same state from view() as from state()', () => {
    const { game } = makeGame(3, { hi: 9 });

    expect(game.view()).toEqual(game.state());
  });

  it('subscribes through the bus it is given', () => {
    const bus = createBus();
    const { game } = makeGame(undefined, { deps: { bus } });
    const seen = collect(game, 'tick');

    bus.emit({ type: 'tick', tick: 1 });

    expect(seen).toEqual([{ type: 'tick', tick: 1 }]);
  });

  it('makes its own bus when none is given, and on() returns an unsubscribe', () => {
    const { game } = makeGame();
    const unsubscribe = game.on('start', () => undefined);

    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});

describe('createMemoryStore', () => {
  it('loads what was saved, starting from the initial value', () => {
    const store = createMemoryStore();
    expect(store.load()).toBeNull();

    store.save(250);

    expect(store.load()).toBe(250);
    expect(createMemoryStore(17).load()).toBe(17);
  });
});

describe('test helpers', () => {
  it('runUntil fails at maxTicks instead of looping', () => {
    const { game } = makeGame();

    expect(() => runUntil(game, () => false, 50)).toThrow(/after 50 ticks/);
  });

  it('runUntil returns the ticks it took once the predicate holds', () => {
    const { game } = makeGame();

    expect(runUntil(game, (s) => s.phase === 'idle', 10)).toBe(0);
  });

  it('makeGame scripts randomSeed in order, then counts calls', () => {
    const { randomSeed } = makeGame(undefined, { seeds: [11, 22] });

    expect([randomSeed(), randomSeed(), randomSeed()]).toEqual([11, 22, 3]);
  });
});
