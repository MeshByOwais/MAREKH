# Remaining prototype features — Columbia Hills

Implemented locally on 15 November 2026. Scope: the gaps identified from the shared **Visualize Marswalk Route** conversation, including its five explicitly deferred mission-decision ideas. The seven-site picker and acquisition of the other six site datasets remain excluded by the user's instruction.

## What now works

| Prototype requirement | Implementation |
| --- | --- |
| Conditions at every route position | Synthetic ground temperature in coherent 100 m scenario cells, a configurable daily variation, assumed regional pressure, and cumulative dose equivalent. Profile, map card and Helmet use one evaluator. |
| Walking and stopping time | Configurable level speed and grade slowdown; outbound and return grades both contribute. Science duration is forecast, and sampling actually spent is retained if the remaining stop is skipped. |
| Explain every red section | Surface slope, cold ground, cumulative exposure and return-time alerts can overlap. Each contributing reading is highlighted independently. Disabled environmental readings are unavailable and trigger no environmental alert. |
| Integrated terrain | Orbital image remains visible under steep-ground hatching, source-linked science context, route and incident overlays. Slope/hillshade remain optional inspection surfaces. |
| Select a route position on the map | Tap near the selected route in Briefing to project onto its polyline and move the shared cursor. Where outbound and return overlap, prefer the occurrence closest to the current cursor. Sliders still allow either leg to be selected explicitly. |
| Continuous-route comparison | Calculate both objectives with common endpoints and distance ceiling. Keep both independently audited candidates, their individual requests and numerical bounds, then select either for profile and rehearsal. A matching single-objective search can retain the other candidate. |
| Drop-off comparison | Save valid staging candidates A and B and calculate both with the same continuous objective and constraints. Compare full distance, peak grade, climb, modeled duration and scenario exposure, then load either mission. |
| Helmet | Shared readings, a visor frame/crosshair, readable route/rover/science labels, next destination and active alert reasons. Choosing an incident repair preserves Helmet mode and the exact current position. |
| Mission decisions | Mark a simulated boulder field or missing-data area ahead, or mark a boulder field on the map. Compare a checked detour to science plus a separate rover return against returning immediately. |
| Coverage gaps | Actual unknown terrain remains an unfilled hole with a dashed boundary. Simulated unknown cells are blocked, inflated for crew clearance, shaded and outlined. An old route crossing a new mark becomes unapproved/dashed; playback is disabled until a checked choice is selected or the exercise is reset. |
| Return reserve | Total time budget, reserve, maximum sampling allowance, latest science departure and estimated return update with position and route choice. Incident options exceeding budget/reserve cannot be selected. |
| Science decision | Source photo and context remain at the stop. Add five minutes of sampling or skip remaining sampling and return. Skipping does not erase time already spent. Replay starts a new sampling rehearsal. |
| Configuration-driven missions (original U6) | A same-origin mission descriptor supplies identity, terrain package, route packages, science card, context labels, credits, default model and scenario. No site picker is added. See the contract below. |
| Export | Download the current mission's geometry, selected route, cursor, scenario, incidents, completed distance and route provenance as JSON. An incident repair is explicitly marked as engine checked, without an independent audit or continuous optimality certificate. |

## Environmental and time model

These are **demonstration scenarios**, not live Columbia Hills measurements or operational suit limits.

- Ground temperature = editable baseline + a synthetic 100 m-cell spatial term + a cosine over an illustrative 24-hour clock. The clock advances by modeled physical elapsed time. This is not a THEMIS observation or atmospheric temperature map.
- Pressure defaults to 636 Pa as illustrative regional context. NASA's Mars Fact Sheet gives 6.36 mb at mean radius, not a measurement at this site.
- Dose equivalent defaults to 0.67 mSv per 24 hours / 27.9167 µSv per hour. This is a historical Curiosity RAD reference at **Gale Crater, August 2012–June 2013**, applied as a constant demonstration rate. It does not provide spatial shielding, solar events or current Columbia Hills conditions. µSv and absorbed dose in µGy are not interchangeable.
- Each native route piece takes `3D distance / level speed × (1 + grade penalty × abs(tan(signed grade)))` seconds. Default speed is 0.6 m/s and grade penalty is 4. Both are editable assumptions, not a validated astronaut mobility or fatigue model.
- The total forecast includes at least the planned science stop or sampling time already spent, whichever is greater. At the science cursor, elapsed time includes sampling actually spent; after the stop, the return forecast includes the remaining planned sampling. Rehearsal animation speed never enters these calculations.
- Cold/dose thresholds are editable scenario alerts. The surface-slope threshold remains part of the loaded route model.

Sources: [NASA Mars Fact Sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html), [NASA Curiosity RAD release](https://www.nasa.gov/news-release/nasa-rover-results-include-first-age-measurement-on-mars-and-help-for-human-exploration/), [NASA RAD measurement explanation](https://science.nasa.gov/resource/radiation-measurements-on-mars/).

Historical, georeferenced THEMIS observations, current space weather, validated human walking models and verified shielding are separate future data/model work. The implemented scenario restores the prototype interaction without presenting invented measurements as observations.

## Routing and verification boundaries

Normal continuous planning retains the existing native elevation-portal search, fixed-corridor continuous improvement and independent Python audit. Each candidate keeps its own request and bounds. Comparing two candidates does not establish the exact continuous optimum.

Incident repair uses the existing **Field D* crew model** with checked native segments, roughness and swept clearance, rather than claiming a new continuous certificate. Its visible walking-grade cap is separate from the continuous plan's cap; the default is the crew model's 20° demonstration maximum. The resulting peak grade is reported before selection. A lower cap can fail to produce a candidate even when a continuous route might exist: the guidance field is conservative and local extraction is heuristic. No constraints are silently relaxed.

Completed travel is preserved as history; only future pieces are checked against newly reported incidents. The repaired route ends at the original rover, and its return may differ from its outbound path. Large projected northings use retained native coordinates during revalidation to avoid tiny spurious boundary fragments. A failed search or cancellation retains the previous route. New positions invalidate pending incident choices. Reset incident exercise restores the prior mission and its provenance display.

## Mission descriptor contract — no picker

The default is `public/missions/columbia-hills.json`. Load another prepared descriptor directly with `/?mission=/missions/your-mission.json`.

A descriptor uses schema version 1 and contains:

- `id`, `name`, `region`, `credits`, `focusFeatureId` and optional `context` labels/review URL;
- `terrain`: a relative URL to a schema-2 terrain package;
- `packages`: available `crew`, optional `baseline`, optional `global` package paths and route versions;
- `defaultModel`: a supplied model;
- `science`: title, description, image, alternate text, credit and an HTTP(S) source link;
- `scenario`: the documented editable environmental/walking defaults;
- `continuousServiceMission`: the matching server's mission identifier, or `null` when unavailable.

Paths resolve relative to the descriptor. Terrain `siteId` must match the descriptor ID. Assets must be same-origin. Native terrain arrays and saved route assets keep their existing hash, dataset and audit checks. Grid input bounds come from the loaded dimensions. Context labels and the science card come from data.

A new prepared site can use the generic browser crew planner without changing routing or camera code. The local continuous service is still registered to Columbia Hills; a descriptor cannot silently run another site's requests against that service. It must use its crew model or have a separately prepared matching continuous service. This release does not claim to have acquired or registered six additional Mars sites.

## Validation

See `remaining-prototype-verification.json` for numerical and browser evidence. Tests cover time/dose units, simultaneous alerts, unavailable readings, reserve calculations, spent sampling, skipped science, incident masks, exact current-position preservation, future native checks, rover closure, return-only behavior and large-coordinate regression. Desktop and phone checks exercise the real prepared Columbia Hills package.
