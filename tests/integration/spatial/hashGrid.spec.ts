import { expect, test } from "@playwright/test";

/**
 * Moves many sensors around with the "grid" broad phase and checks, every
 * frame, that the reported collision pairs match a brute-force overlap test.
 */
test("grid broad phase reports the same pairs as a brute-force check", async ({ page }) => {
    await page.addScriptTag({ path: "dist/kaplay.js" });

    const result = await page.evaluate(() => {
        const k = kaplay({
            global: false,
            width: 640,
            height: 480,
            broadPhaseCollisionAlgorithm: "grid",
            hashGridSize: 32,
        });

        const SIZE = 20;
        // Ignore pairs this close to touching, where the narrow phase may go
        // either way
        const EPS = 0.01;

        // Deterministic pseudo-random numbers
        let seed = 12345;
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };

        const pausedParent = k.add([k.pos(0, 0)]);
        pausedParent.paused = true;

        type Obj = ReturnType<typeof k.add>;
        const objs: { obj: Obj; vx: number; vy: number; active: boolean }[] =
            [];

        for (let i = 0; i < 200; i++) {
            // Mix of active sensors, area-only objects, paused objects and
            // children of a paused parent
            const kind = i % 10;
            const isAreaOnly = kind === 7;
            const isPaused = kind === 8;
            const inPausedParent = kind === 9;
            const parent = inPausedParent ? pausedParent : k.getTreeRoot();
            const obj = parent.add([
                k.pos(rnd() * 600, rnd() * 440),
                k.rect(SIZE, SIZE),
                k.area({ isSensor: !isAreaOnly }),
                `o${i}`,
            ]);
            if (isPaused) obj.paused = true;
            objs.push({
                obj,
                vx: (rnd() - 0.5) * 400,
                vy: (rnd() - 0.5) * 400,
                active: !isAreaOnly && !isPaused && !inPausedParent,
            });
        }

        const reported = new Set<string>();
        const key = (a: Obj, b: Obj) =>
            a.id! < b.id! ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;

        for (const { obj } of objs) {
            obj.onCollideUpdate((other: Obj) => {
                reported.add(key(obj, other));
            });
        }

        let frames = 0;
        let updated = false;
        let checkedPairs = 0;
        const errors: string[] = [];

        // Runs before the AfterUpdate collision pass
        k.onUpdate(() => {
            updated = true;
            reported.clear();
            for (const o of objs) {
                if (!o.active) continue;
                const p = o.obj.pos;
                p.x += o.vx * k.dt();
                p.y += o.vy * k.dt();
                if (p.x < 0 || p.x > 620) o.vx = -o.vx;
                if (p.y < 0 || p.y > 460) o.vy = -o.vy;
            }
        });

        // Runs after the collision pass of this frame
        k.onDraw(() => {
            // Only check frames where the update and collision pass ran. The
            // first frame is skipped, since the broad phase is initialized
            // lazily during it.
            if (!updated) return;
            updated = false;
            frames++;
            if (frames === 1) return;
            for (let i = 0; i < objs.length; i++) {
                for (let j = i + 1; j < objs.length; j++) {
                    const a = objs[i];
                    const b = objs[j];
                    const pa = a.obj.worldPos;
                    const pb = b.obj.worldPos;
                    const overlap = Math.min(
                        SIZE - Math.abs(pa.x - pb.x),
                        SIZE - Math.abs(pa.y - pb.y),
                    );
                    const expected = a.active && b.active && overlap > EPS;
                    const forbidden = !a.active || !b.active
                        || overlap < -EPS;
                    const got = reported.has(key(a.obj, b.obj));
                    if (expected) checkedPairs++;
                    if (expected && !got) {
                        errors.push(`frame ${frames}: missed ${i}-${j}`);
                    }
                    if (forbidden && got) {
                        errors.push(`frame ${frames}: extra ${i}-${j}`);
                    }
                }
            }
        });

        return new Promise<{
            frames: number;
            checkedPairs: number;
            errors: string[];
        }>(res => {
            k.wait(2, () => res({ frames, checkedPairs, errors }));
        });
    });

    expect(result.frames).toBeGreaterThan(10);
    expect(result.checkedPairs).toBeGreaterThan(10);
    expect(result.errors.slice(0, 10)).toEqual([]);
});

test("grid removes a sensor that grew across the full grid width", async ({ page }) => {
    await page.addScriptTag({ path: "dist/kaplay.js" });

    const matches = await page.evaluate(() => {
        const k = kaplay({
            global: false,
            width: 64,
            height: 64,
            broadPhaseCollisionAlgorithm: "grid",
            hashGridSize: 32,
        });

        return new Promise<boolean[]>(resolve => {
            k.onLoad(() => {
                const sensor = k.add([
                    k.pos(32, -32),
                    k.area({
                        isSensor: true,
                        shape: new k.Rect(k.vec2(0), 10, 10),
                    }),
                ]);
                const query = new k.Rect(k.vec2(-64, 32), 1, 1);
                const results: boolean[] = [];
                let frame = 0;

                k.onUpdate(() => {
                    frame++;
                    if (frame === 2) {
                        // The grid extends from -64 to 128 on this canvas.
                        sensor.pos = k.vec2(-64, 0);
                        sensor.area.shape = new k.Rect(k.vec2(0), 192, 32);
                    }
                    else if (frame === 3) {
                        sensor.area.shape = new k.Rect(k.vec2(0), 10, 32);
                    }
                    else if (frame === 4) {
                        sensor.destroy();
                    }
                });

                k.onDraw(() => {
                    if (frame === 0) return;
                    let found = false;
                    k._k.game.retrieve(query, object => {
                        if (object === sensor) found = true;
                    });
                    results.push(found);
                    if (frame === 4) resolve(results);
                });
            });
        });
    });

    expect(matches).toEqual([false, true, true, false]);
});

test("grid sees a sensor unpaused by an earlier collision callback", async ({ page }) => {
    await page.addScriptTag({ path: "dist/kaplay.js" });

    const collidedInSamePass = await page.evaluate(() => {
        const k = kaplay({
            global: false,
            width: 64,
            height: 64,
            broadPhaseCollisionAlgorithm: "grid",
            narrowPhaseCollisionAlgorithm: "box",
        });

        return new Promise<boolean>(resolve => {
            k.onLoad(() => {
                const addSensor = (x: number) =>
                    k.add([
                        k.pos(x, 0),
                        k.rect(12, 12),
                        k.area({ isSensor: true }),
                    ]);
                const first = addSensor(0);
                const second = addSensor(2);
                const initiallyPaused = addSensor(4);
                initiallyPaused.paused = true;

                let unpaused = false;
                let collided = false;
                first.onCollide(other => {
                    if (other === second) {
                        initiallyPaused.paused = false;
                        unpaused = true;
                    }
                });
                second.onCollideUpdate(other => {
                    if (other === initiallyPaused) collided = true;
                });
                k.onDraw(() => {
                    if (unpaused) resolve(collided);
                });
            });
        });
    });

    expect(collidedInSamePass).toBe(true);
});

test("grid reports each pair once when a collision callback grows it", async ({ page }) => {
    await page.addScriptTag({ path: "dist/kaplay.js" });

    const updates = await page.evaluate(() => {
        const k = kaplay({
            global: false,
            width: 64,
            height: 64,
            broadPhaseCollisionAlgorithm: "grid",
            narrowPhaseCollisionAlgorithm: "box",
        });

        return new Promise(resolve => {
            k.onLoad(() => {
                const addSensor = (x: number) =>
                    k.add([
                        k.pos(x, 0),
                        k.rect(12, 12),
                        k.area({ isSensor: true }),
                    ]);
                const first = addSensor(0);
                const second = addSensor(4);
                let originalPair = 0;
                let addedPair = 0;

                first.onCollideUpdate(other => {
                    if (other !== second) return;
                    originalPair++;
                    if (originalPair === 1) {
                        const third = addSensor(240);
                        const fourth = addSensor(244);
                        third.onCollideUpdate(candidate => {
                            if (candidate === fourth) addedPair++;
                        });
                    }
                });

                k.onDraw(() => {
                    if (originalPair > 0) resolve({ originalPair, addedPair });
                });
            });
        });
    });

    expect(updates).toEqual({ originalPair: 1, addedPair: 1 });
});
