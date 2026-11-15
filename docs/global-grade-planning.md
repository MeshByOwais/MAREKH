# Continuous walking-grade search

The selected objective is **minimum maximum absolute walking grade, then distance**, with a **500 m total round-trip budget**. The model remains a crew walk. This saved result supplements the previous NASA-informed guidance and preserved A* baseline; it does not change their outputs.

The default app model shows the candidate route, a continuous grade bracket, and a separate distance interval at the reported feasible grade cap. **An exact continuous optimum is not claimed.** A finite graph search supplies a feasible route; an independently checked continuous potential supplies lower bounds. The remaining gaps are visible. No tolerance chosen by the user is silently assumed.

## Saved result

| Quantity | Result |
| --- | ---: |
| Checked round-trip surface distance | 494.662 m |
| Peak absolute walking grade | 2.600619° |
| Continuous minimum-grade bracket | 2.150°–2.601° |
| Remaining grade gap | 0.451° |
| Shortest round trip at a 2.601° cap | 476.286–494.662 m |
| Remaining distance gap at that cap | 18.376 m |
| Maximum crossed-cell surface slope | 12.205560° |
| Positive climb, both legs | 9.246598 m |

The 2.150° potential proves a one-way lower distance of **250.397373 m**, exceeding 250 m. Thus no continuous route with that peak grade can meet the 500 m round-trip budget in this model. The feasible route provides the upper end. The earlier terrain-priority crew result was 413.208 m with a 14.308° peak walking grade; this result spends more distance to lower that grade.

These intervals are achieved bounds, not a claim that the exact grade-first/distance-second optimum has been found. Further global corridor searches or finer potential representations may reduce the gaps.

## Defined problem

Use the complete native 990 × 990 elevation grid and its original piecewise-planar triangles. Coordinates and lengths are projected metres; distance means 3D length on that surface. The display mesh is not an analysis input. Keep the checked staging and approach points, native coverage and exclusions, and the crew model's conservative 1 m full-route clearance, roughness and native surface-slope rules.

Walking grade is `atan(abs(dz) / horizontal_length)` on each linear piece. It differs from the underlying ground's surface slope: crossing a slope obliquely can reduce walking grade while retaining substantial side slope. This is not a metabolic-cost or minimum-climb objective.

Movement rules are static and symmetric. For any eligible round trip of length at most 500 m, at least one leg has length at most 250 m. Reverse that leg to obtain an equally good or better symmetric round trip. Thus the minimum attainable peak grade, and minimum distance at a fixed grade, can be searched one way with a 250 m budget. The saved return is independently checked in reverse.

There is no minimum turn radius or step length. Tight switchbacks are therefore allowed. The length budget prevents arbitrarily long switchbacks from driving the primary objective toward zero, but it does not establish human walkability at small scales. These are demonstration mobility limits and orbital data, not operational EVA certification.

## Feasible upper bound

`tools/global_grade_portals.cpp` shares elevation portals along native triangle edges. Each graph edge is an actual straight 3D surface segment inside one original triangle, and must satisfy the tested grade cap. Portal points can have fractional row/column coordinates and their connecting segments have continuous headings; this is not an eight-neighbour path.

After graph extraction, `tools/polish_global_route.py` optimizes the continuous positions inside the selected native faces, fixing the contour-direction branch of each segment. Grade constraints are linear within a branch, while each 3D segment length is a second-order cone constraint. This supplies a shorter feasible candidate in that corridor; it does not prove global optimality. The candidate is rounded to a conservative 0.001° grade cap and checked again on the actual native surface.

The graph only uses squares whose four native cells pass crew clearance. This is conservative near obstacles. Shortest-path searches at successive grade caps find a budget-feasible candidate. The cost is 3D length. The A* heuristic is the maximum of the 3D endpoint chord and the unavoidable elevation change divided by the sine of the grade cap; both are consistent lower bounds for graph edges.

A coarse search is followed by finer portals in an 8 m corridor around its witness. Corridor restriction affects only feasible upper candidates. **The lower-bound domain remains the complete budget rectangle.** A finite portal graph or a refined corridor does not prove continuous optimality, and its resolution is not presented as a continuous error bound.

The TypeScript packager checks the witness with the existing full native interpolation, cell-intersection and crew-clearance rules. It retains native triangle/cell crossings, recomputes 3D objective cost and all metrics, and rejects a budget or grade violation. The independent Python checker then audits both legs and checks the physical swept capsule against raw hazard boxes.

## Continuous lower bound

Any one-way path of length at most 250 m lies inside the horizontal ellipse whose foci are the two endpoints and whose focal-distance sum is 250 m. `domain.json` records a rectangle strictly enclosing that ellipse, with a native-cell halo. The independent checker rederives its extrema. Bounds do not rely on the upper-search corridor.

A potential `phi` assigns a finite scalar to every native vertex in this rectangle and interpolates affinely on each native terrain triangle. It is continuous across shared edges. For every face, verify that its derivative in **every unit surface direction** whose absolute grade is at most `theta` has magnitude at most 1. Then every eligible continuous path satisfies:

```text
phi(start) - phi(goal) <= path length.
```

This follows by integrating the directional derivative along the path. It covers arbitrary directions, face crossings, contour following and switchbacks, whether or not the route search sampled them. Hard hazards are deliberately ignored in the lower-bound problem: expanding the feasible set can only weaken a lower bound.

For the all-heading check, use an orthonormal uphill/contour tangent basis on a face. Let `(qu, qv)` be the potential gradient in that basis, and `alpha` the face's inclination. Permitted unit directions have uphill component bounded by:

```text
a = min(1, sin(theta) / sin(alpha)).
```

Flat faces use `a = 1`. The maximum absolute derivative is exactly:

```text
sqrt(qu² + qv²),                      if |qu| <= a * sqrt(qu² + qv²)
a*|qu| + sqrt(1-a²)*|qv|,            otherwise.
```

The optimizer proposes a potential using second-order cone constraints for the exact polar of the allowed unit-direction set. Its status is not a certificate. The generator evaluates every actual native face with the full formula and globally rescales the potential by the worst violation plus a conservative factor. The checker independently reconstructs face gradients directly from the source grid, slightly broadens the checked grade cap, and rejects a potential exceeding its derivative limit. It subtracts 0.00001 m from the one-way endpoint difference.

A verified one-way lower bound greater than 250 m makes the tested grade infeasible under the round-trip budget. This establishes the lower end of the grade bracket. The actual checked route establishes its upper end. A second potential at the feasible grade cap supplies the distance lower bound; twice the checked one-way route length supplies its upper bound.

The certificates use double precision and explicit conservative margins. They are **numerical bounds, not a formal interval-arithmetic proof**. The exact continuous grade may be an infimum when arbitrarily tight turns or limiting boundary approaches are permitted. The secondary interval applies at the reported feasible cap; it does not assert exact lexicographic optimality at an unknown exact grade.

## Validation and artifacts

The versioned package is `public/sites/columbia-hills/global-grade-v1/`. It includes routes, endpoints, config, bounds, domain, complete native potential arrays, certificate metadata, the independent audit, GIS geometry, segment CSV and a north-up orbital review. Its manifest pins the terrain and crew manifests and hashes every asset. The checker compares the complete certificate area and all route support heights with the original HiRISE IMG.

Eight additional tests cover flat and tilted analytical potentials, a dense independent heading oracle, altered/nonfinite potentials, invented lower bounds, the budget ellipse and the complete saved package audit. Prior terrain, source and navigation checks remain part of validation.

Generation requires Bun, a C++17 compiler and Python with the pinned numerical dependencies in `tools/requirements-global-grade.txt`. The independent audit and production build require only the existing NumPy/GDAL/Pillow environment; they do not run or trust the optimizer.

```bash
cd /home/owais/MAREKH
# Install optional generation dependencies in an isolated folder, if absent.
/usr/bin/python3 -m pip install --target data/work/global-python -r tools/requirements-global-grade.txt
export PYTHONPATH="$PWD/data/work/global-python"
export PATH="$HOME/.bun/bin:$PATH"
export COLUMBIA_GDAL_PYTHON=/usr/bin/python3
python3 tools/global_grade_bounds.py --mesh
g++ -O3 -std=c++17 tools/global_grade_portals.cpp -o data/work/columbia-hills/global-grade-v1/portals
data/work/columbia-hills/global-grade-v1/portals data/work/columbia-hills/global-grade-v1 0.005
python3 tools/global_grade_bounds.py --refine
data/work/columbia-hills/global-grade-v1/portals data/work/columbia-hills/global-grade-v1 0.001
python3 tools/polish_global_route.py
# Generate potentials at the reported lower and feasible upper grade caps.
python3 tools/global_grade_bounds.py --grade 2.15
python3 tools/global_grade_bounds.py --witness-grade
bun run generate:global
bun run test:global
bun run build
```

The second potential uses the actual feasible cap saved by the upper-witness calculation. The lower potential must prove a one-way distance greater than 250 m; otherwise the bracket must be widened or the search refined. A solver failure must not be relabelled as infeasibility. Numerical generation can take minutes on this machine. The browser reviews saved results; movable endpoints and background interactive replanning remain future work.

## Relationship to NASA methods

The previous NASA-informed model follows the public global-guidance/local-check architecture. Field D*'s linear interpolation improves headings and costs, but its assumption and a greedy local extractor do not certify this continuous minimax-grade problem. This additional solver is an independently derived bounded search, not NASA flight software. [Ferguson and Stentz, Field D*](https://publications.ri.cmu.edu/storage/publications/pub_files/pub4/ferguson_david_2006_3/ferguson_david_2006_3.pdf)

Clarabel supplies numerical proposals through its public Python interface; the independent verifier does not import it. [Clarabel official Python interface](https://clarabel.org/stable/python/getting_started_py/)

## Verification on this machine

All **60 tests** passed (32 TypeScript and 28 Python), including the eight added analytical and certificate checks. The production build, type checks and all independent terrain/navigation audits passed. The new route audit checked **1,762 native pieces**, **668 route support cells** and **43,026 certificate-area source cells**, with zero source-height difference. Each of the two potentials was checked against every allowed heading on **85,224 native triangles**. The existing non-failing Three.js bundle-size advisory remains.

Browser review confirmed the default bounded-grade result, its outward-rounded intervals and downloads, both preserved comparison models, mode-specific crew-clearance state, and restoration of the default after reload. Browser diagnostics contained no warnings or errors. The temporary local preview was stopped after verification; use the README preview command to reopen it.

[Full browser preview](global-grade-preview.png) · [Route and bounds preview](global-grade-bounds-preview.png) · [Independent audit](../public/sites/columbia-hills/global-grade-v1/validation.json)
