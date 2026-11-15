# Staging changes that appeared not to update the route

Fixed locally on 15 November 2026.

A second failure was reproduced after the preview process exited with signal 15: the existing page remained visible, but a new worker could not be fetched and the planner reported a background-search failure. The production app now imports its worker with Vite’s [inline-worker support](https://vite.dev/guide/features#web-workers), so each search starts from code already loaded with the page. The local server was restarted. This protects subsequent searches for the current loaded model and terrain; initial loading, reloading and switching to an uncached model still require a server.

The reported location was native cell **457, 429**. Its 10 m square touches a cell with a **12.15°** surface slope, above the configured **5° staging limit**. The engine correctly retained the previous plan. The error was shown above the map, while the result section continued to show the old route without explaining the difference between the requested and applied starts.

The interface now checks the full candidate square immediately after map selection or numeric entry. A rejected square and marker turn red; the reason appears both by placement and by the route results. The route section states the start used by the displayed plan. Passing candidates turn green and identify that **Plan both routes** still needs to apply the location. Search progress, failures and successful updates appear in both places.

**Find nearby valid staging** proposes the nearest passing native-cell staging square within 100 m. The result shows its coordinates and displacement before the user applies it. Suggestions check complete closed-cell footprints, known elevation/slope, exclusions, the 5° limit and, for crew mode, the checksum-verified raw roughness/hazard mask. An integral-count grid makes the local footprint search bounded and fast. A passing staging square does not guarantee route connectivity; both route searches still run and validate the full walk before replacing the current plan.

For the reported location, the suggestion was **457, 409**, **20.21 m** away, with a **4.95°** maximum staging slope. Applying it changed the two crew round trips from 404.43 / 413.21 m to **310.74 / 315.79 m**. The downloaded browser plan passed the independent Python audit of **2,970 native pieces**, both footprints, both-leg metrics and swept crew clearance. See [the audit record](staging-location-audit.json); the audited plan is retained locally at `data/work/phase-4/live-crew-457-409.json`.

Validation: **43 TypeScript tests passed**, including comparison of the suggested staging location with an exhaustive reference search, complete-footprint/hazard checks, the search radius, unknown coverage and no-result cases. Type checking and the production bundle passed. Browser verification reproduced the exact rejected location, immediate error, nearby suggestion, explicit application and changed route metrics; no browser warnings or errors were recorded.

The staging and route limits remain unchanged. The saved continuous-grade candidate and its bounds remain tied to their original endpoints.

The server-disconnection regression was tested on the production page by loading crew mode, stopping the local server, and starting a new search from **396, 498**. Both searches succeeded without a network worker fetch, producing **244.78 / 251.35 m** round trips with **2,486** checked native pieces. The local server was then restarted, leaving this latest selected location and its updated routes visible.
