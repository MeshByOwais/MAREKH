# Phase 3 — Verified Columbia Hills round trips

Completed locally on **14 November 2026** in `/home/owais/MAREKH`. Phase 3 meets the first route milestone: a reproducible command generates both route policies, returns to the departure point, exports them in the native Mars CRS and independently audits every edge. The local app displays the saved routes and metrics. Live start placement, worker searches and a linked profile remain Phase 4.

## Saved result

Dataset: `columbia-hills-terrain-1`. Route version: `columbia-hills-routes-1`. Distances are sums of three-dimensional native-cell edge lengths. The return reverses the outbound geometry, with signed grades and positive climb recomputed in that direction.

| Complete round trip | Shortest | Gentler terrain |
| --- | ---: | ---: |
| Distance | 411.3881 m | 418.5368 m |
| Horizontal distance | 410.4625 m | 417.5660 m |
| Positive climb, both legs | 10.6689 m | 11.6990 m |
| Maximum crossed-cell surface slope | 13.7923° | 9.9443° |
| Maximum absolute along-move grade | 12.5678° | 10.0020° |
| Edges above the 10° surface warning, both legs | 16 | 0 |
| Outbound points / checked round-trip edges | 149 / 296 | 155 / 308 |
| Expanded search cells | 3,438 | 15,968 |

The gentler option adds **7.1488 m** to the round trip and reduces the maximum surface slope by **3.8479°**. It has **1.0300 m more positive climb**. The policy optimizes a surface-slope penalty, so it does not promise the smallest possible maximum slope or least climb. Travel time is null because no walking-speed model has been established.

## Endpoint decision and image review

All coordinates below are projected east/north metres in the unchanged HiRISE Mars local-sphere equirectangular CRS. Rows and columns are zero-based, and locations use native pixel centres.

| Endpoint | Native cell | East / north | Elevation | Footprint |
| --- | --- | --- | ---: | --- |
| Demo staging | row 370, column 406 | 1452.653033 / −865309.789965 m | −1926.064575 m | 10 × 10 m; 121 touched cells; maximum 4.560973° |
| Demo science approach | row 503, column 554 | 1602.213136 / −865444.191950 m | −1918.469604 m | 2 × 2 m; 9 touched cells; maximum 9.171033° |

The staging square lies wholly inside the Phase 1 50 m search square northwest of Home Plate. Candidate 11 × 11 cell windows were compared across rows 357–392 and columns 402–437. The chosen window has the lowest maximum slope, with mean slope, row and column breaking ties. Its optical appearance was inspected alongside Home Plate: the subdued western patch avoids the stronger ridge to the east, and no resolved obstacle or reviewed exclusion crosses its footprint. Every closed native cell box touching the footprint is checked, including boundary contact.

The original science approach was a continuous proposed coordinate. This version explicitly adopts the centre of cell (503,554), **0.294255 m** from that proposal, and records both coordinates and the displacement. It remains inside the original 15 m science-context allowance. The route API accepts integer cells and never silently snaps an invalid endpoint. The original evidence and terrain-package mission annotations are retained; the connected demo endpoint decisions live separately in `routes-v1/mission.json`.

These decisions approve endpoints only for the recorded demonstration. Orbital imagery does not resolve every small rock, loose ground or bearing-strength hazard. The 15 m context allowance is not a geolocation confidence interval, and absolute accuracy remains unknown. The departure footprint is not swept along the walking route; routes use point positions with conservative native-cell supercover checks.

## Versioned rules and deterministic search

[Routing configuration](../config/columbia-hills/routing-v1.json) records units, assumptions, selection rationale and algorithm conventions:

- Surface warning: **above 10°**. This flags an edge without blocking it.
- Route surface limit: **20°**, inclusive, across every native cell touched by an edge.
- Staging surface limit: **5°**, inclusive, across its complete footprint.
- Absolute move grade limit: **20°**, inclusive, checked separately using elevation change over horizontal length.
- Shortest cost: `hypot(horizontal metres, elevation change metres)` per edge.
- Gentle cost: `edge length × (1 + 4 × (maximum crossed-cell slope / 20°)²)`. The weight is non-negative and dimensionless.

`src/routing/planner.ts` implements eight-neighbour A* with a binary priority queue. Its heuristic is projected horizontal Euclidean distance, admissible for both costs. Ties sort by total estimated cost, then heuristic, then row-major index. Neighbours are visited in fixed row/column order, and the first equal-cost predecessor is retained.

A diagonal includes both adjacent cardinal side cells in its supercover. Both side cells must be passable, and all four endpoint-to-side cardinal transitions must satisfy the grade limit. This deliberately conservative rule makes passability and costs symmetric under reversal. Invalid coverage, nonfinite data, exclusions, excessive surface slopes and excessive grades cannot be crossed. The completed path is checked again before generating leg metrics.

The API reports `outside_coverage`, `blocked_start`, `blocked_goal` or `no_route` before claiming a result. Unknown endpoint data produces `outside_coverage`. Invalid array dimensions, transforms or policy configuration throw an input error. Each successful leg retains native cell indices, projected position, source elevation and surface slope, cumulative three-dimensional and horizontal distance, signed segment grade and maximum crossed-cell slope. First-point segment grade is zero; cumulative distances reset at the start of each leg. The science turnaround index is the final outbound point, with its outbound cumulative distance saved separately.

## Independent audit and GIS evidence

`tools/validate_routes.py` does not import the routing engine. It separately computes closed-cell footprint intersections, native-cell supercovers, four cardinal side grades, edge lengths, slope maxima, costs, warnings, climb, per-point fields and cumulative distances. It checks source-linked endpoint locations, exact reversed cell sequences, the science turnaround and closure at the departure point.

All **604 edges** passed. It also checked **799 unique route-supercover and endpoint-footprint cells** directly against the original HiRISE IMG; elevation differences are zero. Every saved asset has a manifest byte count and SHA-256 digest, and the route manifest pins the terrain manifest and exact routing configuration.

The GIS export stores 3D route vertices and endpoint points in the native Mars CRS, with staging/approach footprints, original context annotations, reviewed exclusion polygons and a polygonized native valid-data footprint. The checker reopens it and verifies the CRS, all route vertices, endpoint coordinates, footprint polygons, exclusions and valid footprint area. A CSV retains independently recomputed values for each leg edge.

| File in `public/sites/columbia-hills/routes-v1/` | Contents |
| --- | --- |
| [routes.json](../public/sites/columbia-hills/routes-v1/routes.json) | Both successful results, complete leg samples, metrics and turnaround |
| [mission.json](../public/sites/columbia-hills/routes-v1/mission.json) | Checked endpoint footprints, original proposal displacement and demo decision scope |
| [config.json](../public/sites/columbia-hills/routes-v1/config.json) | Exact versioned rules and rationale |
| [validation.json](../public/sites/columbia-hills/routes-v1/validation.json) | Independent audit output |
| [route-review.gpkg](../public/sites/columbia-hills/routes-v1/route-review.gpkg) | Native Mars-CRS GIS layers; four route features include outbound and return |
| [route-edges.csv](../public/sites/columbia-hills/routes-v1/route-edges.csv) | 604 independently recomputed edge records |
| [route-review.png](../public/sites/columbia-hills/routes-v1/route-review.png) | North-up optical review showing both routes and endpoint footprints |
| [manifest.json](../public/sites/columbia-hills/routes-v1/manifest.json) | Version, CRS, input pins and asset hashes |

For desktop GIS review, open the GeoPackage alongside `data/work/columbia-hills/phase2/optical.tif`, `elevation.tif` or `slope-deg.tif`. Use its native Mars CRS without assigning an Earth EPSG code. The saved PNG is a visual review, not a georeferenced raster export.

## Reproduce and verify

Use the existing prepared terrain or first follow the Phase 2 preparation record.

```bash
cd /home/owais/MAREKH
export PATH="$HOME/.bun/bin:$PATH"
export COLUMBIA_GDAL_PYTHON=/usr/bin/python3
bun run generate:routes
bun run validate:routes
bun run test
bun run test:coverage
bun run test:terrain
bun run test:pathfinding
bun run build
bun run preview --port 4175
```

`generate:routes` regenerates both policies and then audits and exports the package; it fails if a configured footprint or route cannot pass. It does not relax limits. Core route JSON regeneration is tested for exact equality. The GIS package includes SQLite metadata, so its whole-file bytes need not be identical between exports; hashes are refreshed for the actual artifact.

All **36 tests** passed: the previous 20 checks, 12 new search tests and four independent audit tests. New cases cover analytic diagonal distance, slope detours and no-route barriers, an intentional gentle trade-off, blocked corners, separate grade limits, explicit endpoint failures, signed return grades/climb, same-cell missions and malformed inputs. A separately written Dijkstra implementation checks optimal costs on the analytic fixtures and 20 deterministic varied grids for both policies. Real-data results regenerate exactly and repeated searches are deterministic. Negative audit tests reject tampered coordinates, elevations, grades, slope fields, cumulative distances, climb and blocked diagonal side cells.

TypeScript and the production build passed. The existing non-failing Three.js bundle-size advisory remains; no dependencies were added. Browser review passed for saved metrics, 3D alignment, the route visibility control, native slope layer and north-up view. Browser diagnostics contained no errors or warnings. The existing local preview service was reused and left running; no hosted deployment was created.

- [Default 3D route preview](phase-3-routes-preview.jpg)
- [North-up slope review](phase-3-slope-preview.jpg)

## Next: Phase 4

Make staging movable with map and keyboard placement, validate its entire footprint for each change, run both policies in a worker and preserve the last valid plan on failure. Add a distance-linked route profile and shared slope alerts across outbound, turnaround and return. Keep time and environmental readings unavailable until their models and sources are established.
