# Phase 1 — Columbia Hills source and coverage review

Date: 14 November 2026 (Asia/Karachi)  
Workspace: `/home/owais/MAREKH`  
Status: Complete. Mission endpoints are provisional until Phases 2 and 3.

## Result

The real HiRISE digital terrain model, matching grayscale orthophoto, and detached image label are downloaded, sized and hashed. A source-linked review map marks Home Plate, a Gertrude Weise science context area, a proposed science approach, a candidate staging search area, and the shared valid footprint. An aligned crop is ready for the next phase.

Open [the standalone review](phase-1-review.html) directly from disk. Its maps, layer controls, and verification record are embedded, so it does not need a running server. The app version is `review.html`, available through the local preview server. At Phase 1 completion the index page held the synthetic fixture. Phase 2 moves that fixture to `fixture.html` and makes real terrain the default app.

## Acquired products

| Product | Size | Use |
| --- | ---: | --- |
| `DTEEC_001513_1655_001777_1650_U01.IMG` | 283,089,408 bytes | Float32 elevations from stereo observations |
| `PSP_001513_1655_RED_C_01_ORTHO.JP2` | 24,931,905 bytes | Matching red-band grayscale orthophoto |
| `PSP_001513_1655_RED_C_01_ORTHO.LBL` | 5,325 bytes | Intended Mars mapping, null/saturation definitions and provenance |

The stereo source observations were acquired on 22 November and 12 December 2006. The orthophoto shown uses the 22 November observation. Product versions are 1.0. The source records include dates, credits, URLs, verified byte counts and computed SHA-256 hashes. The hashes establish the local downloaded baseline; no independently published archive checksum was supplied for comparison.

NASA reference images PIA09089 and PIA11758, their locally archived captions, and Ruff et al. (2008), LPSC abstract 2213, were also saved under `data/raw/columbia-hills/references/`. Reference images and the PDF have pinned hashes in the inventory. The research figure stays in local working data and is not reproduced in the browser package.

## Projection and grid decision

Both sources have 6,524 columns and 10,847 rows. The label-backed grid uses an equirectangular Mars projection with a 3,395,580 m local spherical radius, standard parallel -10 degrees, central meridian 175.5 degrees east, projected east/north axes in metres, and planetocentric latitude. Native pixel spacing is 1.0105412400975 m, with north at the top. Rendering and analysis must preserve the recorded affine transform and pixel-centre convention.

**Open the orthophoto through the `.LBL` file, not directly through the JP2.** On this machine, the native JP2 advertises a different spherical radius/projection interpretation and a roughly 1.516 m easting / -1.516 m northing grid-origin difference. The detached label read by GDAL's PDS driver yields exactly the same CRS, dimensions and affine transform as the DTM. A saved `ortho-label.vrt` retains that interpretation without changing the original downloads. This avoids an incorrect reprojection of imagery that is already on the intended DTM grid.

The DTM's label defines elevations in metres relative to the Mars 2000 equipotential surface (Smith et al. 2001), with scale 1 and offset 0. The NoData value read by GDAL is approximately -3.402822655e38. The optical label defines DN 0 as unknown and DN 1/255 as saturation indicators. Shared coverage means valid elevation and non-null image; it does not certify unsaturated optical measurements, resolve small hazards, or establish ground traversability.

## Crop and footprint

| Measurement | Verified value |
| --- | --- |
| Source pixel window, zero-based x/y/width/height | 4390 / 5985 / 990 / 990 |
| Mission crop | 1000.436 m square |
| Crop grid | 990 by 990 cells |
| Shared valid crop cells | 980,100 of 980,100 (100%) |
| Shared valid source cells | 54,514,016 of 70,765,828 |
| West / east bounds | 1041.868019 / 2042.303846 m |
| South / north bounds | -865935.820263 / -864935.384436 m |
| Crop elevation range | -1939.976 to -1834.115 m |

The native-resolution shared coverage mask is polygonized into the GIS package. A separate acceptance check confirms that its polygon area equals the valid native cell count times cell area. The crop is snapped to the original grid and includes the science context, the candidate staging search area and surrounding terrain for alternate routes.

## Landmark and science registration

Home Plate was located against NASA's PIA09089 reference image from the same orbital observation. An initial coarse normalized-correlation search gave a best score of 0.923 near source window x=4789, y=6399, width=192, height=168. Ruff et al.'s Figure 1 was then registered in that neighbourhood using unannotated image pixels, followed by affine fitting to six local control patches.

The science context comes from the figure's red location square labeled Kenosha Comets in Gertrude Weise, near image coordinate (515, 177) in the extracted 739 by 471 pixel figure. This is a map-context marker, not a surveyed point for the disturbed soil.

- Relative map-fit RMS: **0.401 m**.
- Largest leave-one-out residual: **0.958 m**.
- Approximate Home Plate context: -14.602913 degrees latitude, 175.526592 degrees east longitude.
- Approximate science context: -14.602983 degrees latitude, 175.527450 degrees east longitude.

These residuals describe agreement between images, not absolute geolocation on Mars. Absolute DTM geolocation accuracy is unknown. Coordinates retain numeric precision for reproducibility, not a claim of surveyed accuracy. The science context has a **15 m local planning buffer**, chosen conservatively to cover interpretation of the published marker; it is not a statistical confidence interval or a bound on absolute position.

The Home Plate rim and nearby ridges were inspected in both the orthophoto and elevation hillshade. Their shared grid and major landforms agree in the review. No independent ground-control accuracy was established for DTM-to-image alignment.

NASA's PIA11758 observation was acquired on 21 May 2007, sol 1202, after the orbital image. Its photo documents the silica-rich soil; the 2006 orbital image supplies topographic context and cannot be treated as a direct image of the later wheel excavation.

## Proposed mission geometry

`mission-review.json` separates the science evidence area from the proposed walking endpoint. The provisional approach lies 12 m south of the registered context marker, inside its planning buffer. A 50 m square northwest of Home Plate is marked as a staging search area, based only on image context and shared coverage.

Both proposals still require native slope, reviewed exclusions, staging-footprint and connectivity checks. Neither is approved as a walkable or safe endpoint. `approvedStagingPoint` and `approvedScienceApproach` remain null. The source inventory's `stagingPoint` also remains null; its `scienceApproach` is explicitly marked proposed/unverified.

## Files to use in Phase 2

- `config/columbia-hills/sources.json` and `sources.sha256`: inventory, verified hashes, crop window and bounds.
- `config/columbia-hills/coverage-review.json`: metadata and verification record.
- `config/columbia-hills/registration.json`: source controls, fit and held-out residuals.
- `config/columbia-hills/mission-review.json`: provisional science/staging geometry in the native projected CRS.
- `data/work/columbia-hills/phase1/elevation-review.tif`, `optical-review.tif`, and `hillshade-review.tif`: georeferenced review rasters.
- `data/work/columbia-hills/phase1/shared-coverage.tif`: native full-product valid-data intersection.
- `data/work/columbia-hills/phase1/coverage-review.gpkg`: native Mars CRS vector footprint and review landmark layers. Load with the review rasters in GIS; do not assign Earth WGS84.
- `data/work/columbia-hills/phase1/*-info.json`: GDAL JSON inspection records for DTM, native JP2 and label-backed orthophoto.
- `public/sites/columbia-hills/review/`: compact browser maps and review records.

## Reproduce and verify

```bash
cd /home/owais/MAREKH
export PATH="$HOME/.bun/bin:$PATH"
export COLUMBIA_GDAL_PYTHON=/usr/bin/python3
bun install --frozen-lockfile
bun run acquire:sources
bun run review:site
bun run test:coverage
bun run test
bun run export:review
bun run build
bun run preview --port 4175
```

Acquisition needs network access only for missing files. Large source/work files stay under the ignored `data/` directory. Existing source hashes are checked before processing. Python needs GDAL, NumPy and Pillow; Poppler's `pdfimages` extracts the local research figure. These are available on this machine. A changed upstream reference is rejected against its recorded checksum and requires source review.

All six Phase 1 acceptance checks passed, as did the four existing terrain/routing smoke tests, TypeScript checking and the Vite production build. The browser review loaded its maps and records, and switching both the layer and the extent worked without browser warnings or errors. The standalone HTML export passed static checks: all maps/styles are embedded, the embedded report matches the verified configuration, and its module has no external imports or unresolved build variables. Direct file opening could not be automated because the browser tool blocks file URLs; the served app version was verified in the browser. The temporary preview server was stopped after verification. The existing non-failing Three.js bundle-size advisory remains confined to the synthetic preview.

## Next gate

Phase 2 must generate the real analytic elevation/slope/mask package and a real 3D surface, verify coordinates and rendering against this review, and retain missing terrain. Phase 3 must validate endpoints and produce independently checked routes. No real-data route or approved rover drop-off is claimed in Phase 1.

## Primary sources

- [HiRISE DTM and orthophoto catalogue](https://www.uahirise.org/dtm/PSP_001513_1655)
- [First stereo observation and acquisition metadata](https://www.uahirise.org/PSP_001513_1655)
- [Second stereo observation and acquisition metadata](https://www.uahirise.org/PSP_001777_1650)
- [NASA PIA09089, Spirit's Tracks around Home Plate](https://science.nasa.gov/photojournal/spirits-tracks-around-home-plate/)
- [NASA PIA11758, Rover's Wheel Churns Up Bright Martian Soil](https://science.nasa.gov/photojournal/rovers-wheel-churns-up-bright-martian-soil/)
- [Ruff et al. (2008), LPSC abstract 2213, Figure 1](https://www.lpi.usra.edu/meetings/lpsc2008/pdf/2213.pdf)
- [GDAL PDS driver and georeferencing cautions](https://gdal.org/en/stable/drivers/raster/pds.html)
- [HiRISE guidance on reading DTM mapping keywords](https://hirise.lpl.arizona.edu/dtm/howto.php)
