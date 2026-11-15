# Live continuous route planning

The actual planner can now rerun the same native elevation-portal A* and continuous conic corridor improvement used to produce the saved grade candidate. It accepts a new staging cell and either of two objectives:

- **Gentlest within a distance limit:** search for a low maximum absolute walking angle under the total round-trip budget, then reduce length in the selected native corridor.
- **Shorter within a peak-grade limit:** minimize 3D route length in the portal graph under a fixed maximum absolute walking angle, then move crossings continuously within the selected native faces to reduce length.

The second mode also enforces the displayed total distance ceiling. Increasing that ceiling allows more detours. Every requested limit is checked on the actual emitted native pieces, on both legs, before a result is accepted. Average absolute walking grade is reported as `sum(3D piece length × abs(piece angle)) / total length`; descent does not cancel ascent. Following the user's preference, this average is a comparison metric, while the grade control limits the steepest section.

## Run

On the configured machine, build and run:

```bash
bun run build
bun run serve:planner
```

Open <http://127.0.0.1:4175/>. A plain Vite server or a static GitHub-hosted page can display saved results and run the older browser crew/A* planners, but cannot execute continuous jobs. The UI reports an unavailable continuous service if it receives a static fallback response.

A fresh machine needs Bun, a C++17 compiler, NumPy/GDAL/Pillow for the independent checker, and the pinned numerical packages in `tools/requirements-global-grade.txt`. A Python environment containing those dependencies can be selected with `COLUMBIA_GDAL_PYTHON`. On this machine, the numerical packages already reside in `data/work/global-python`, which the service adds to its child-process Python path. The compiler builds the small portal executable when required. Original source rasters are needed by the full build audit; the job itself checks versioned prepared arrays and pinned crew masks without downloading terrain.

## Search and validation

The service validates the request, checks both complete endpoint footprints, rebuilds crew terrain assessment, verifies input hashes and matches the persisted clearance mask against the runtime assessment. It isolates each job under `data/work/dynamic/<job-id>/` and never replaces the saved package. The budget ellipse bounds every eligible one-way path, with a full native-cell halo; clipping at the map boundary preserves eligible paths on known terrain. Missing-height vertices remain isolated from every search face; their heights are never filled or used to bridge missing terrain. Live jobs do not create a lower-potential mesh.

A coarse search uses 5 mm elevation portals over the budget domain. A second search uses 1 mm elevation portals within 8 m of the coarse candidate. Each face connects all its edge portals, so paths are not restricted to eight grid directions or the local crew planner's 32 headings. The conic solve then moves crossing coordinates continuously inside selected native faces and turn branches. It cannot discover every other possible corridor. Fixed-cap mode optimizes length once; distance-budget mode also searches grade caps. A numerically invalid polished candidate may only fall back to a checked portal witness.

The TypeScript engine splits every candidate at native terrain boundaries and validates both legs. A separate Python implementation rebuilds roughness and clearance, sweeps the crew footprint against raw hazards, checks exact native geometry, grades, metrics, closure and requested limits, and independently recomputes the reported analytical bounds. Failed checks retain the current route. Cancel, new inputs and model changes discard stale jobs; job cancellation terminates the solver process group.

Only one continuous job runs at a time. Distance requests are limited to 10–1200 m, with a ten-minute job deadline and a 4.5-million-portal resource ceiling. A search failure or resource limit **does not prove continuous infeasibility**. For large or difficult requests, reduce the distance area or adjust the grade cap. Tight turns remain permitted by the mathematical crew model.

## What the bounds mean

Portal resolution and conic convergence do not prove a global continuous optimum. Each returned route supplies a feasible upper bound. Live jobs report conservative global lower bounds from endpoint displacement:

- Any round trip has length at least twice the 3D endpoint chord.
- Under peak grade `g`, a one-way path changing elevation by `Δz` has length at least `abs(Δz) / sin(g)`.
- Under total budget `B`, the minimum achievable peak grade is at least `asin(2 × abs(Δz) / B)`.

Small numerical margins are subtracted from these lower bounds. The grade interval concerns the minimum peak grade within the chosen budget. The distance interval concerns minimum length at the requested peak cap, or at the candidate peak cap for the gentlest objective. They are separate optimization questions. These bounds can be wide and are floating-point numerical bounds, not interval-arithmetic proofs. The tighter saved conic-potential certificates are not automatically reused for changed requests. The exact continuous optimum remains unknown.

## Verification

Run `bun test`, `python3 -m unittest discover -s tests -p 'test_*.py'`, and `bun run build`. Tests include small portal-search fixtures with known shortest lengths and impossible grade/distance constraints, request rejection, boundary-domain coverage, analytical bounds, absolute-grade weighting, stale-generation handling and nearly collapsed conic crossings. A downloaded continuous result can also be audited again with:

```bash
bun run validate:live /absolute/path/marekh-live-plan.json
```

Browser validation records and measured live results are in `continuous-planner-verification.json`. Local job folders retain the request, witness, mesh, search log and checked downloadable result for reproduction. The API and local static server bind only to loopback and reject cross-origin mutation requests.
