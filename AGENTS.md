# Maintaining the SpaceDeck fork

`spacedeck` carries four downstream performance patches. The series started at upstream commit `8a1c549c`. The `upstream` remote is `kaplayjs/kaplay`, and `origin` is `Stanko/kaplay`. Use `upstream/master` as the sync target and `spacedeck` as the source of the downstream changes. The `performance-improvements` branch records the earlier experiments.

## Downstream patches

These hashes identify the original port. Use the subjects to find the patches after a rebase.

| Commit | What to preserve when syncing |
| --- | --- |
| `5654803f` `perf: simplify HashGrid cell membership` | Reuse the cell-index buffer, store named version fields per object, and compare sorted, unique cell indices in one pass. Areas fully outside the grid have no cells. Check collision eligibility live so later pairs see callback changes. If a callback rebuilds the grid, skip objects already processed in that pass. See `src/math/spatial/hashgrid.ts` and `tests/integration/spatial/hashGrid.spec.ts`. |
| `e0b9f08b` `perf: reuse sprite geometry buffers` | Reuse numeric geometry buffers and pass resolved texture sizes and regions through the draw path. Keep the default texture region as plain data so standalone math imports can initialize. `BatchRenderer.push()` receives the number of populated floats, including when recording into a `Picture`. See `src/gfx/draw/` and `tests/integration/gfx/spriteGeometry.spec.ts`. |
| `f20d3d9a` `perf: skip child snapshots for leaves` | Run lifecycle callbacks before checking whether the object has children. Preserve the child snapshot for nonempty lists so callbacks can mutate the tree during traversal. See `src/ecs/entity/GameObjRaw.ts`. |
| `ba9cef53` `perf: preallocate batch renderer queues` | Reuse typed arrays and upload only their populated ranges. Ignore empty live draws and grow the CPU queues and GPU buffers together. Flush before a combined batch would wrap 16-bit indices. An individual draw may reference vertex indices `0` through `65,535`. Preserve picture recording behavior. See `src/gfx/gfx.ts` and `tests/integration/gfx/batchRenderer.spec.ts`. |

The fork uses upstream particle updates and the regular collision schedule, with passes after fixed updates and regular updates.

## Syncing with upstream master

1. Start with a clean working tree, check the remotes, and fetch `upstream`.
2. Save the current tip and merge base. Review the four downstream patches and check for equivalent upstream fixes before rebasing.
3. Replay the patches onto `upstream/master` in order. Resolve conflicts against the current upstream code and preserve the behavior described above. Use `git range-diff` to review the resulting series.

```sh
git status --short --branch
git remote -v
git fetch upstream
git switch spacedeck
old_tip=$(git rev-parse HEAD)
old_base=$(git merge-base "$old_tip" upstream/master)
git log --reverse --oneline "$old_base..$old_tip"
git rebase upstream/master
git range-diff "$old_base..$old_tip" upstream/master..HEAD
```

After resolving conflicts, rebuild before running tests. The browser tests load `dist/kaplay.js`.

```sh
npm run build
npm test
git diff --check upstream/master..HEAD
```

The original port with the resize fix passed 158 Playwright tests. When changing the engine version used by SpaceDeck, update the exact dependency pin and lockfile together in the SpaceDeck checkout.

## Performance reference

The comparison ran SpaceDeck `162a9195` with the installed KAPLAY build at `a9680214` and the fork before the resize guard. In the seeded stress level, main-thread work fell from 11.31 to 6.14 ms/frame, collision work from 8.15 to 2.12 ms/frame, and minor GCs from 188 to 60 per run. The resize guard separately measured 2.08 ms/frame of collision work both before and after.

For a comparable run, use the same SpaceDeck revision, seed, scene, and graphics settings. Mute audio, run the stress level in god mode with idle controls, and measure 900 frames after 240 warmup frames. Compare runs with matching object and area counts at sampled checkpoints and 1,650 collision passes per run.
