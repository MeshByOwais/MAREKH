# Phase 4 — Interactive planning

Completed locally on **15 November 2026** in `/home/owais/MAREKH`.

The planner now changes staging, searches two route policies in a Web Worker, and connects a complete round-trip elevation profile to the map. The saved continuous-grade candidate and its original bounds remain available.

## Use the planner

1. Choose **NASA-informed crew planning** or **Phase 3 · A* baseline**.
2. Use **Pick start on map**, then click the terrain, or enter an integer native-grid row and column. The candidate marker does not replace the current staging point.
3. Choose **Plan both routes**. The full 10 × 10 m staging square must pass the 5° limit, known coverage and reviewed exclusions. Crew planning additionally checks native roughness hazards throughout both endpoint footprints and sweeps the 1 m clearance model along the walk.
4. Select a result row or **Inspect route**. Scrub the profile or use the distance slider, including keyboard arrows, Home and End. **Science turnaround** selects the approach; **Next surface warning** moves to a red piece, including on the return.
5. Download a live plan as JSON. Offline independent verification is available with `bun run validate:live /absolute/path/to/marekh-live-plan.json`.

Search failures preserve the current route and profile. Changing the candidate, cancelling or switching models terminates the active worker and invalidates earlier messages. Model loading also rejects stale responses. A two-minute search timeout retains the last plan. Both policies must succeed before the display changes.

The map includes a north indicator that follows camera rotation and an approximate ground scale measured at the view centre. The profile cursor follows cumulative 3D route distance. Signed grade is recomputed for the return; slope alerts use the crossed surface slope of the active piece. Missing readings remain unavailable and produce no warning. Temperature, radiation and walking time remain unavailable.

## Implementation

- `src/routing/interactive.ts`: footprint validation, live planning and full-route rechecks.
- `src/routing/planning.worker.ts`: progress, success and failure messages from background searches.
- `src/routing/profile.ts`: shared distance sampling and slope-alert evaluation.
- `src/planning-ui.ts`: placement, cancellation, result selection, export and accessible profile controls.
- `src/main.ts`: common rendering for saved and live plans, candidate and distance markers, north and scale.
- `tools/validate_live_plan.py`: independent audit of downloaded crew or baseline plans using the existing Python checkers; checks pinned rules, native asset hashes, footprints, both legs, metrics and crew clearance where applicable.

The live export records the chosen staging point in its config. Saved source audits, GIS exports and global certificates are hidden after a live plan replaces the saved result, so they cannot be mistaken for checks of the new geometry. The live export explicitly records no independent audit or continuous certificate; running the offline checker is a separate verification step.

The real-data audit exposed a closed-cell boundary case: a native split could lie infinitesimally below a half-cell boundary, causing a neighbouring slope or hazard cell to be omitted. `touchedCells` now includes both neighbours from either floating-point side. A regression test checks the corner's four cells, slope and hazard rejection. Existing saved packages still pass their independent audits.

## Verification

- **41 TypeScript tests passed**, including eight interactive planning/profile tests and the new boundary regression.
- Full production build passed: package, source terrain, A*, crew and continuous-grade audits, TypeScript checks and Vite. After the final profile-label adjustment, type checking and the production bundle passed again.
- Browser checks passed at the actual narrow in-app viewport: saved model switching, live A* and crew replanning, map placement, keyboard placement, invalid footprint rejection, cancellation, route choice, pointer profile scrubbing, exact end-distance selection, science turnaround and return-leg warnings. No browser warnings or errors were recorded.
- Moving staging from **370, 406** to **371, 406** produced the following live crew results:

| Policy | Round trip | Positive climb | Max surface slope | Peak absolute walking grade |
|---|---:|---:|---:|---:|
| Distance priority | 402.734 m | 11.444 m | 19.718° | 17.240° |
| Terrain priority | 411.205 m | 11.217 m | 14.095° | 14.671° |

The downloaded browser plan passed the independent Python audit of **4,484 native pieces**, both endpoint footprints and swept crew clearance. The audited JSON is retained locally at `data/work/phase-4/live-crew-371-406.json`; its checksum and report are in [the audit record](phase-4-live-audit.json). The A* browser move produced 410.54 m and 417.70 m round trips. Invalid boundary and steep-ground placements retained the previous result.

Preview evidence: [complete planner](phase-4-preview.png) and [return-leg profile warning](phase-4-profile-preview.png).

## Scope and remaining work

Live Field D* crew searches remain heuristic; live A* searches use the original eight-neighbour point-path model. They compare distance and terrain cost, do not minimize peak grade, and do not enforce the saved candidate's 500 m round-trip budget. The saved minimum-grade mode is deliberately fixed to the certified endpoints: it retains its 2.150°–2.601° numerical grade bracket. New starts need newly computed continuous certificates before receiving such bounds.

The staging candidate may be explored across the prepared map; the original staging search polygon remains context. A passing demo footprint is not an operational site approval. The existing orbital-scale terrain, roughness, tight-turn and unknown-ground limitations remain. Native slope thresholds are demonstration assumptions.

Flyover, Helmet rehearsal, reduced-motion animation and the full desktop/mobile release sequence remain **Phase 5**. Thermal coverage, radiation scenarios, walking-time models and interactive continuous certification are separate follow-ups.
