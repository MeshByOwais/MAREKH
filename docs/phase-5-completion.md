# Phase 5 — Route rehearsal and release

Completed locally on **15 November 2026**. This completes the five user stories in the Columbia Hills plan: opening the mission, moving staging, comparing routes, inspecting alerts, and rehearsing the walk.

## Rehearse a selected route

Choose **Flyover** or **Helmet** above the terrain. Both views start at the current profile cursor, use the selected saved or live route, and keep the map marker, signed walking grade, surface warning and distance sliders synchronized. Flyover follows from above; Helmet puts the camera 1.7 m above the sampled native route and faces the current leg. Other route options are hidden during rehearsal so their geometry cannot be mistaken for the selected path. Briefing restores the previous orbit camera.

Use **Play** beside the view tabs or **Play preview** below the map to move by cumulative 3D distance. The preview pauses exactly at the science approach, reveals Spirit’s credited observation, and waits for **Continue return**. The return follows the selected route back to its actual staging point and stops there. **Replay from start** resets without automatically starting motion. **Exit to Briefing**, the Briefing tab and Escape leave rehearsal. The profile, rehearsal slider, five-metre steps, science-stop button and return-staging button all control the same distance.

**Reduced motion** defaults to the operating-system preference. When checked, continuous playback is disabled and the distance/step controls remain available. Changing the preference, switching views, scrubbing the profile or hiding the browser tab pauses playback. Selecting another route or accepting a new live plan resets rehearsal and exits to Briefing. Failed planning requests retain the previous route.

Preview pace controls animation speed; it does not estimate astronaut walking time. The views visualize orbital terrain and retain its resolution, missing-coverage, roughness and tight-turn limits. No synthetic temperature, radiation or walking-time readings have been introduced.

## Science evidence

The science card includes the previously inventoried [NASA Spirit observation, PIA11758](https://science.nasa.gov/photojournal/rovers-wheel-churns-up-bright-martian-soil/), acquired on 21 May 2007, sol 1202, credited to NASA/JPL-Caltech/Cornell. It is a historical approximately true-color panorama, separate from the simulated rehearsal camera and approximate mapped approach. The committed image matches the original source-inventory hash. It loads locally, including without internet access.

## Run a clean demo checkout

```bash
bun install --frozen-lockfile
bun test
bun run build:demo
bun run preview --port 4175
```

`build:demo` verifies every committed terrain/route/science asset and cross-package version link, checks TypeScript, and builds the static app without raw rasters or GDAL. The small synthetic fixture is now committed too, so its page and tests work in a clean checkout. The full `bun run build` retains independent source-raster and route audits. `bun run serve:planner` additionally enables the live continuous solver when its documented Python/C++ dependencies are available.

## Verification

- **53 TypeScript tests and 34 Python tests passed.** Seven new rehearsal tests cover long-frame science-stop handling, pause/replay/seeking, zero-distance and invalid inputs, shared alert sampling, return/end headings, terrain-relative eye height and closure of the real saved route.
- Full source-audited production build, prepared-asset release checks, type checking and the demo build passed.
- Browser playback reached the science stop at **247.331 m**, paused with the observed image, resumed onto the return and stopped at **494.662 m**, at the original staging point.
- Helmet and profile displayed the same warning at **17.76 m**, including **10.36°** crossed surface slope and the same signed grade. Reduced motion disabled playback; five-metre stepping moved both cursors together.
- Desktop **1280 × 800** and phone **390 × 844** layouts were checked. Resizing from desktop exposed a canvas minimum-width issue; the map now shrinks correctly and the phone page has no horizontal overflow. Temporary viewport overrides were reset after checking.
- Model and policy changes, live staging updates, keyboard exit, science/return jumps and replay were checked with the shared cursor. The clean-checkout release build is recorded in the release verification record.

Evidence: [finished Flyover](phase-5-preview.png), [desktop](phase-5-desktop.png), [phone Helmet warning](phase-5-mobile.png), [science stop](phase-5-science-stop.png), and [verification record](phase-5-verification.json).

## Remaining backlog

The current five user stories are complete. Optional thermal observations, a documented walking model and radiation scenario, multi-site support and tighter live continuous optimality certificates remain separate backlog work. They require their own data/model acceptance checks. This release makes no operational mobility or exact continuous-optimum claim.
