# MAREKH — Columbia Hills

Mars Assisted Routing & Environmental Knowledge for Humans. A crew-walk planner starting with Home Plate in Columbia Hills, Gusev Crater.

**Continuous walking-grade search with stated bounds is implemented.** The default result minimizes peak walking grade within a 500 m round trip, then seeks a short route at the feasible grade cap. The checked route is **494.66 m**, with a **2.60°** peak walking grade. The continuous minimum grade is bounded by **2.150°–2.601°**; the exact optimum remains unknown. At the feasible 2.601° cap, minimum distance is bounded by **476.28–494.67 m**.

[Method, proof, numerical limits and reproduction](docs/global-grade-planning.md). Bounds cover continuous headings on the native piecewise-planar surface and retain the crew model's terrain and full-route clearance limits. The original conic certificates remain tied to their original endpoints. The continuous planner now also runs live searches for new staging locations: choose the gentlest candidate within a total distance budget, or a shorter candidate within a peak walking-grade cap. Each live route receives an independent native geometry and clearance audit and conservative analytical bounds. [Live continuous planner](docs/live-continuous-planning.md).

The NASA-informed Field D* crew routes and Phase 3 A* comparison remain selectable and unchanged. [NASA-informed architecture, sources and assumptions](docs/nasa-crew-navigation.md). The project remains a crew-walk planner. **Phase 5 adds Flyover and Helmet rehearsal**, an automatic science-stop pause with the credited Spirit observation, return completion, replay, shared distance controls and reduced motion. [Rehearsal and release guide](docs/phase-5-completion.md).

## Run from a fresh checkout

The prepared terrain and saved routes are included, so the interactive app can run without downloading the original rasters or installing GDAL:

```bash
bun install --frozen-lockfile
bun run build:demo
bun run preview --port 4175
```

Open the printed local URL. `build:demo` verifies the committed browser packages and builds the demo without raw rasters or GDAL. The full `bun run build` command also audits the original source rasters; use the reproduction steps below to prepare that validation environment.

## Open the app on this machine

```bash
cd /home/owais/MAREKH
export PATH="$HOME/.bun/bin:$PATH"
export COLUMBIA_GDAL_PYTHON=/usr/bin/python3
bun run serve:planner
```

The continuous service needs the C++ compiler and numerical Python dependencies described in [the live-planner guide](docs/live-continuous-planning.md); they are installed on this machine. Open the printed local URL. The app needs its local server and WebGL; opening `index.html` directly from disk does not load its modules or terrain assets.

The main page includes the terrain explorer, continuous distance/grade controls, live crew/A* comparisons, the linked profile, and downloads for saved or live results. `/review.html` contains the Phase 1 source/coverage review, and `/fixture.html` retains the small synthetic 3D fixture. [The standalone Phase 1 review](docs/phase-1-review.html) can also be opened directly from disk.

## Reproduce the preparation and build

```bash
bun install --frozen-lockfile
bun run acquire:sources
bun run prepare:data
bun run prepare:terrain
bun run validate:terrain
bun run generate:routes
bun run generate:crew
bun run test
bun run test:coverage
bun run test:terrain
bun run test:pathfinding
bun run test:crew
bun run test:global
bun run build
```

Generate the bounded-grade package with the separate numerical workflow in [its method document](docs/global-grade-planning.md), then run `bun run generate:global`. Saved certificates and route assets are already present; no optimization solver is needed for the build or independent audit.

Generate crew navigation after regenerating the A* baseline, since its manifest is pinned as endpoint evidence. The acquisition command downloads missing source files and verifies pinned hashes. The raw products total about 308 MB. Current sources and prepared assets are already present on this machine. To regenerate the Phase 1 review, use `bun run review:site` and `bun run export:review`.

Bun 1.3.10 is pinned in `.bun-version` and `package.json`. Dependency versions are exact and the generated graph is in `bun.lock`. Python `/usr/bin/python3` provides GDAL 3.8.4, NumPy 1.26.4 and Pillow. The Phase 1 review additionally uses Poppler's `pdfimages`. Vite and TypeScript run with Bun explicitly; system Node is not used for app commands.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run acquire:sources` | Acquire and verify inventoried HiRISE and scientific reference files |
| `bun run review:site` | Rebuild Phase 1 coverage, landmark registration, GIS assets and review maps |
| `bun run export:review` | Export the self-contained Phase 1 HTML review |
| `bun run prepare:data` | Prepare the small synthetic fixture |
| `bun run prepare:terrain` | Export real native elevation, Horn slope, coverage, reviewed exclusions, textures, mission geometry and manifest |
| `bun run validate:terrain` | Verify hashes, full source-grid equality, independent slopes, texture values/orientation and display approximation |
| `bun run generate:routes` | Generate both versioned routes, independently validate every edge and endpoint footprint, and export GIS/map/CSV evidence |
| `bun run validate:routes` | Verify saved route hashes, native/source samples, metrics, return closure and GIS coordinates |
| `bun run generate:crew` | Generate Field D* plus local crew routes, audit full-route clearance, and export derived maps/GIS |
| `bun run validate:crew` | Independently verify full-grid roughness and inflation, swept footprints, native source geometry, metrics and GIS |
| `bun run generate:global` | Package the continuous grade candidate and certificates, independently audit them and export GIS/map/CSV |
| `bun run validate:global` | Verify continuous all-heading lower bounds, grade/distance budget, native source and swept clearance |
| `bun run test:global` | Run eight analytical, tampering and saved-certificate tests |
| `bun run test:crew` | Run 11 Field D*/crew tests and five independent audit tests |
| `bun run test:pathfinding` | Run 12 search tests (including independent Dijkstra comparison) and four independent audit tests |
| `bun run test` | Run synthetic preparation, validation and four routing-input smoke tests |
| `bun run test:coverage` | Run six Phase 1 acquisition, georeferencing and coverage checks |
| `bun run test:terrain` | Run five analytic terrain checks and five coordinate/mesh checks |
| `bun run test:rehearsal` | Verify playback, science pause, camera height, return headings and real-route closure |
| `bun run validate:prepared` | Check all committed browser assets, package links and the science image against their hashes |
| `bun run build:demo` | Build the verified prepared demo without original rasters or GDAL |
| `bun run typecheck` | Check TypeScript source and tests |
| `bun run build` | Validate terrain and route packages, check TypeScript, and build the app into `dist/` |
| `bun run dev` | Start the Vite development server after preparation |
| `bun run preview --port 4175` | Serve the static production build; continuous search API is unavailable |
| `bun run serve:planner` | Serve the production build with the live continuous planner on port 4175 |

## Data and documentation

- `config/columbia-hills/`: source inventory/hashes, crop, toolchain, registered mission context, manual exclusions and validation reports.
- `data/raw/columbia-hills/`: original products and references, excluded from Git.
- `data/work/columbia-hills/phase1/`: georeferenced coverage review and GIS package.
- `data/work/columbia-hills/phase2/`: real elevation, slope, hillshade, coverage and exclusion GeoTIFFs.
- `public/sites/columbia-hills/terrain-v1/`: versioned browser package and north-up validation map.
- `public/sites/columbia-hills/routes-v1/`: saved route/config/endpoint JSON, independent report, Mars-CRS GeoPackage, per-edge CSV and north-up optical review.
- `public/sites/columbia-hills/crew-navigation-v1/`: Field D* crew routes, assessment grids, full-route clearance overlay, independent report and GIS exports.
- `public/sites/columbia-hills/global-grade-v1/`: continuous-grade candidate, independent global-bound certificates, domain, report and GIS exports.
- `tools/global_grade_bounds.py`, `global_grade_portals.cpp`, `polish_global_route.py`: lower potentials, feasible portal paths and continuous corridor improvement.
- `src/routing/field-dstar.ts`, `crew-terrain.ts`, `crew-planner.ts`: interpolated incremental guidance, native assessment and local crew steps.
- `src/routing/planner.ts`: deterministic eight-neighbour A*, symmetric passability, both policies and round-trip metrics.
- `src/terrain/`: binary/coordinate contract and a display mesh that preserves unknown coverage.
- `tests/`: analytic, source/coverage and mesh/coordinate checks.

[Development plan](Columbia-Hills-Development-Plan.md) · [Phase 0 record](docs/phase-0-completion.md) · [Phase 1 record](docs/phase-1-completion.md) · [Phase 2 record](docs/phase-2-completion.md) · [Phase 3 record](docs/phase-3-completion.md)

## Phase 4: interactive planning

Choose **NASA-informed crew planning** or **Phase 3 · A* baseline**, then pick a staging cell on the map or enter its row and column. **Plan both routes** checks the full 10 m staging square and searches in a Web Worker. Cancel, change the candidate, or switch models to discard an older search. Invalid placements and failed searches retain the current plan. The candidate square is checked immediately and turns red if rejected; the reason also appears beside the route, with its actual start. **Find nearby valid staging** proposes the closest passing native-cell square within 100 m and shows its displacement before you apply it with **Plan both routes**. Crew suggestions include the verified roughness-hazard mask; connectivity is checked by the subsequent route search.

Select a policy in the results or **Inspect route**. Scrub the two-leg elevation profile by pointer, touch or the distance slider; keyboard arrows, Home and End are supported. **Science turnaround** jumps to the approach; **Next surface warning** finds a red piece. The map marker, signed walking grade, crossed surface slope and alert reason use the same distance cursor. Live plans can be downloaded as JSON.

Choose **Continuous route planner** to use the native elevation-portal and conic system for new staging locations. **Gentlest within a distance limit** searches for a low peak grade within the total budget. **Shorter within a peak-grade limit** seeks a short route with every native piece below the selected cap; the distance ceiling is also enforced. Average absolute grade is reported separately. Continuous jobs need `bun run serve:planner`, can take minutes, and receive independent checks before display. Their analytical global bounds can be wider than the original saved certificates. Live crew and A* searches still compare distance and terrain cost without these constraints. The UI distinguishes saved evidence, independently checked continuous results and crew/A* engine checks. Production pages include the search worker in their loaded bundle, so new searches for the already loaded model and terrain continue if the local server stops. Initial loading, reloading and fetching another model still need the server.

Run `bun run test:interactive` for the planning/profile checks. Independently audit a downloaded plan with `bun run validate:live /absolute/path/marekh-live-plan.json` (requires the existing Python/GDAL environment). See [Phase 4 completion and limits](docs/phase-4-completion.md). Rehearsal is implemented in Phase 5 below.

## Phase 5: rehearse the selected walk

Choose **Flyover** or **Helmet** above the map. **Play preview** follows the selected route, pauses at the science approach with Spirit’s historical observation, and waits for **Continue return** before finishing back at staging. The profile and rehearsal distance controls share one cursor. **Replay from start**, **Exit to Briefing**, Escape and the five-metre step buttons are available. **Reduced motion** defaults to the system preference and keeps navigation manual. Preview pace is not a walking-time estimate.

All five current user stories are complete. See [the Phase 5 record](docs/phase-5-completion.md) for the release sequence, evidence and the separate conditions/multi-site backlog.
