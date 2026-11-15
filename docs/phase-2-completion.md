# Phase 2 — Real terrain, native slopes and a verified 3D surface

Date: 14 November 2026 (Asia/Karachi)  
Workspace: `/home/owais/MAREKH`  
Status: Complete. Approved mission endpoints and routes remain Phase 3 work.

## What changed

The default app now opens the real Columbia Hills terrain around Home Plate. It offers the observed grayscale orthophoto, derived slope colors, elevation hillshade, reviewed exclusion overlays, orbit/zoom, Home Plate/full-crop/north-up views, and native-cell inspection. The original synthetic scene remains at `fixture.html`. Phase 1's source and coverage review remains at `review.html`.

The analytic package preserves the reviewed 990 by 990 native grid. Display reduction is confined to the 3D mesh; routing can use the original arrays. Science context, the proposed science approach and candidate staging area are draped onto the same surface. They remain proposals.

## Dataset contract

Package: `public/sites/columbia-hills/terrain-v1/`  
Dataset version: `columbia-hills-terrain-1`  
Manifest schema: 2

| Asset | Definition |
| --- | --- |
| `manifest.json` | Source IDs and hashes, Mars CRS, dimensions, affine transform, bounds, local origin, datum, units, storage, statistics, render policy, asset sizes and SHA-256 hashes |
| `elevation.f32` | Native Float32, little-endian, row-major, north to south; original elevations in metres |
| `slope-deg.f32` | Native Horn slope in degrees; NaN where a complete slope neighbourhood is unavailable |
| `coverage.u8` | 1 for finite elevation, finite slope and non-null imagery; 0 for unknown |
| `exclusions.u8` | 1 for the manually marked precautionary regions; separate from coverage and slope |
| `texture.webp` | Lossless grayscale RGB copy of the aligned HiRISE red-band crop, with matching bounds and dimensions |
| `slope.webp`, `hillshade.webp` | Derived display layers, on the same grid |
| `exclusions.webp`, `exclusions.json` | Transparent reviewed-region overlay and the source-linked reasons/polygons |
| `mission.json` | Science evidence area and proposed approach/staging geometry; approved endpoints null |
| `north-up-validation.png` | Native slope map, reviewed exclusions, mission geometry, north and scale |

The original downloads are unchanged. Preparation verifies their recorded hashes and reads the optical `.LBL`, preserving the Phase 1 projection correction. GeoTIFF elevation, slope, hillshade, coverage and exclusion rasters are saved under `data/work/columbia-hills/phase2/` for GIS inspection alongside the Phase 1 GeoPackage.

## Terrain measurements

| Measurement | Result |
| --- | --- |
| Native grid | 990 by 990 cells |
| Horizontal spacing | 1.0105412400975 m |
| Crop width/height | 1000.436 m |
| Valid elevation/slope/image cells | 976,144 of 980,100 (99.5964%) |
| Unknown analytic cells | 3,956, the outer one-pixel ring |
| Elevation range | -1939.976 to -1834.115 m |
| Slope range | 0.004894 to 38.264557 degrees |
| Slope median / 95th percentile | 6.103 / 16.128 degrees |
| Precautionary exclusion cells | 74,529 |

The crop has observed elevation and image coverage at every cell, as Phase 1 found. The analytic coverage is slightly smaller because the outer pixel ring lacks a complete slope neighbourhood. Edge slopes remain unknown; no interpolation fills them.

## Slope accuracy and rounding correction

GDAL 3.8.4's Horn kernel sums Float32 input heights. At the negative Mars datum, cancellation produced up to 0.010915 degrees difference from an independent double-precision Horn calculation. Preparation now subtracts a constant reference elevation (-1922.150757 m) in a separate slope input before calling GDAL. A constant shift preserves terrain gradients. Exported source elevations and their datum remain unchanged.

Independent calculation across every interior native cell now differs by at most **0.000001852 degrees**, below the 0.0001-degree tolerance. Analytic flat ground, a two-axis inclined plane, raster borders and a missing-cell neighbourhood also pass their expected slope checks. The hillshade uses the same centred input to avoid the same cancellation issue.

Implementation evidence: [GDAL 3.8.4 Horn slope source](https://raw.githubusercontent.com/OSGeo/gdal/v3.8.4/apps/gdaldem_lib.cpp) and [GDAL DEM processing documentation](https://gdal.org/en/stable/programs/gdaldem.html).

## Coordinates, imagery and display fidelity

The native projected affine transform and Mars datum are retained from Phase 1. Pixel coordinates refer to centres. Local east is +X, elevation minus the recorded reference is +Y, and north is -Z. The vertical scale is 1:1.

- Every exported elevation equals the original DTM crop exactly: maximum difference **0 m**.
- Every lossless texture channel equals the aligned orthophoto DN exactly: maximum difference **0**. Pixel-centre UVs map the north edge to the image's top.
- Five saved source spot checks agree exactly. Projected-coordinate round-trips pass on both the real north-up grid and a sheared test transform.
- The reduced display has **486,098 triangles** with approximately 2.02 m spacing. Every used vertex matches its native elevation and projected position.
- Against every native cell, display-triangle interpolation differs by at most **0.958679 m**, with **0.019385 m RMS**. These are display approximation measurements, not source-data accuracy claims.
- A reduced quad is omitted if any native cell inside its footprint is unknown, even when all four sampled corners are valid. Missing-cell and non-finite-height fixtures confirm the mesh does not bridge gaps.

The browser's north-up slope view was compared with the saved Phase 1/2 overlays. Terrain inspection selected row 488, column 502, returning -1921.50 m elevation and 5.45 degrees slope; those values were independently checked against the native arrays. The optical, slope and hillshade layers, exclusion toggle and view controls were exercised. No application browser errors or warnings were reported in that check.

## Reviewed exclusions and endpoint limits

Two regions of visible parallel ridged/bedform texture, west and east of Home Plate, are marked as precautionary planning exclusions. Their polygons, digitized image pixels, source product and reasons are stored in `config/columbia-hills/exclusions.json`. Rasterization conservatively includes every touched cell.

This is a limited visual review. Unmarked ground is not certified safe, orbital-scale slopes do not resolve all hazards, and absolute Mars geolocation accuracy remains unknown. Surface slope, future move grade, warning thresholds and route exclusion thresholds are separate quantities. Phase 2 does not choose those route policy values. Approved rover departure and science approach fields remain null.

## Checks and reproducibility

All **20 tests** passed: four original fixture/routing smoke tests, six Phase 1 checks, five new Python terrain checks and five TypeScript coordinate/mesh checks. The full-grid package validator, TypeScript check and production build passed. A subsequent viewer framing adjustment also passed TypeScript checking and a fresh build.

```bash
cd /home/owais/MAREKH
export PATH="$HOME/.bun/bin:$PATH"
export COLUMBIA_GDAL_PYTHON=/usr/bin/python3
bun install --frozen-lockfile
bun run acquire:sources
bun run prepare:data
bun run prepare:terrain
bun run validate:terrain
bun run test
bun run test:coverage
bun run test:terrain
bun run build
bun run preview --port 4175
```

Open the local URL printed by the preview command. The interactive 3D app requires this local server and WebGL; opening its source HTML directly from disk does not load the app. The standalone Phase 1 review remains available for direct-file viewing.

The production build still emits the non-failing Three.js bundle-size advisory (about 564 kB before compression). No new dependencies or hosted deployment were added. The temporary verification server is stopped after review.

## Saved review artifacts

- [Home Plate 3D preview](phase-2-terrain-preview.jpg)
- [Full-crop 3D preview](phase-2-full-crop-preview.jpg)
- [North-up slope preview](phase-2-slope-preview.jpg)
- [Native north-up validation overlay](../public/sites/columbia-hills/terrain-v1/north-up-validation.png)

The final full-crop framing was visually verified after the adjustment. The final browser diagnostics reported no application errors or warnings.

## Next: Phase 3

Define versioned slope/grade/staging assumptions, validate candidate endpoint footprints, build deterministic A* and both cost policies, generate the round trip, and verify every edge against these native arrays. The real terrain package is ready for that work; no real-data route is claimed yet.
