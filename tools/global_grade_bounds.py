"""Generate continuous-direction lower certificates and a native portal mesh.

Clarabel proposes potentials; verification does not trust solver status or
sampled headings. See docs/global-grade-planning.md for the full argument.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
TERRAIN = ROOT/'public/sites/columbia-hills/terrain-v1'
CREW = ROOT/'public/sites/columbia-hills/crew-navigation-v1'
WORK = ROOT/'data/work/columbia-hills/global-grade-v1'
CONFIG = ROOT/'config/columbia-hills/global-grade-v1.json'


def load_inputs():
    manifest = json.loads((TERRAIN/'manifest.json').read_text())
    crew_manifest = json.loads((CREW/'manifest.json').read_text())
    for folder, record, names in [(TERRAIN, manifest, ['elevation.f32', 'coverage.u8']),
                                  (CREW, crew_manifest, ['config.json', 'clearance-blocked.u8'])]:
        for name in names:
            data = (folder/name).read_bytes()
            assert len(data) == record['assets'][name]['bytes']
            assert hashlib.sha256(data).hexdigest() == record['assets'][name]['sha256']
    crew = json.loads((CREW/'config.json').read_text())
    config = json.loads(CONFIG.read_text())
    assert manifest['datasetVersion'] == config['datasetVersion'] == crew['datasetVersion']
    shape = manifest['rows'], manifest['columns']
    z = np.fromfile(TERRAIN/'elevation.f32', '<f4').reshape(shape).astype(float)
    blocked = np.fromfile(CREW/'clearance-blocked.u8', 'u1').reshape(shape).astype(bool)
    return manifest, crew, config, z, blocked


def domain_bounds(start, goal, spacing, one_way_budget, shape):
    """Bounding rectangle of the horizontal budget ellipse, plus a full cell.

    Every point on any path of length <= budget has sum of horizontal focal
    distances <= budget. Rectangle boundaries are deliberately outside ellipse.
    """
    a = one_way_budget/(2*spacing)
    delta = np.asarray(goal, float)-start
    c = np.linalg.norm(delta)/2
    if a <= c:
        raise ValueError('Budget must exceed the horizontal endpoint distance')
    b = math.sqrt(a*a-c*c)
    unit = delta/(2*c) if c else np.array([1., 0.])
    radii = np.sqrt(a*a*unit**2+b*b*unit[::-1]**2)
    mid = (np.asarray(start)+goal)/2
    lo = np.floor(mid-radii).astype(int)-1
    hi = np.ceil(mid+radii).astype(int)+1
    # Terrain outside the supplied map is unavailable, so clipping preserves
    # every eligible path on this map, including boundary-adjacent requests.
    lo = np.maximum(lo, 0)
    hi = np.minimum(hi, np.asarray(shape)-1)
    return [int(lo[0]), int(hi[0]), int(lo[1]), int(hi[1])]


def build_mesh(inputs=None, work=WORK, upper_only=False):
    m, crew, config, z, blocked = inputs or load_inputs()
    start = [crew['staging']['cell'][k] for k in ['row', 'column']]
    goal = [crew['approach']['cell'][k] for k in ['row', 'column']]
    bounds = domain_bounds(start, goal, m['transform'][1], config['roundTripBudgetM']/2, z.shape)
    r0, r1, c0, c1 = bounds
    yy, xx = np.mgrid[r0:r1+1, c0:c1+1]
    points = np.column_stack([yy.ravel(), xx.ravel(), z[r0:r1+1, c0:c1+1].ravel()])
    nc = c1-c0+1
    ids = np.arange(len(points)).reshape(yy.shape)
    a, b, c, d = ids[:-1, :-1].ravel(), ids[:-1, 1:].ravel(), ids[1:, :-1].ravel(), ids[1:, 1:].ravel()
    # Keep the lower-bound mesh complete: dropping hazards is a relaxation and
    # makes every real feasible path eligible. Never alter source elevations.
    faces = np.concatenate([np.column_stack([a,b,c]), np.column_stack([d,c,b])]).astype('<i4')
    if not upper_only:
        assert np.isfinite(points[:,2]).all(), 'Bound domain contains unknown elevation'
    # Upper witnesses use only squares whose four native cells pass clearance.
    free = ~blocked[r0:r1+1,c0:c1+1]
    ok = (free[:-1,:-1]&free[:-1,1:]&free[1:,:-1]&free[1:,1:]).ravel()
    upper_faces = faces[np.tile(ok,2)]
    assert np.isfinite(points[upper_faces,2]).all(), 'A witness face contains unknown elevation'
    # Live jobs use endpoint-based lower bounds and need no complete lower
    # mesh. Unknown vertices remain isolated; never fabricate their heights.
    lower_faces = faces[:0] if upper_only else faces
    work.mkdir(parents=True, exist_ok=True)
    points.astype('<f8').tofile(work/'vertices.f64')
    lower_faces.tofile(work/'lower-faces.i32')
    upper_faces.tofile(work/'upper-faces.i32')
    upper_faces.tofile(work/'upper-faces-all.i32')
    record = dict(bounds=bounds, vertexCount=len(points), lowerFaceCount=len(lower_faces), upperFaceCount=len(upper_faces),
                  startIndex=(start[0]-r0)*nc+start[1]-c0, goalIndex=(goal[0]-r0)*nc+goal[1]-c0,
                  spacingM=m['transform'][1], oneWayBudgetM=config['roundTripBudgetM']/2,
                  portalElevationStepM=config['portalElevationStepM'])
    (work/'mesh.json').write_text(json.dumps(record, indent=2)+'\n')
    # Plain header for the dependency-free C++ upper-witness search.
    (work/'mesh.txt').write_text(' '.join(str(record[k]) for k in ['vertexCount','upperFaceCount','startIndex','goalIndex','spacingM','oneWayBudgetM','portalElevationStepM'])+'\n')
    print(json.dumps(record), flush=True)
    return record


def refine_mesh(radius_m=8, work=WORK):
    """Focus upper search only; the continuous LOWER domain is never reduced."""
    m=json.loads((work/'mesh.json').read_text());w=json.loads((work/'witness.json').read_text())
    points=np.fromfile(work/'vertices.f64','<f8').reshape(-1,3)
    original=work/'upper-faces-all.i32'
    if not original.exists():original.write_bytes((work/'upper-faces.i32').read_bytes())
    faces=np.fromfile(original,'<i4').reshape(-1,3)
    from scipy.spatial import cKDTree
    xy=np.array([[p['row'],p['column']] for p in w['points']])
    distances=cKDTree(xy).query(points[:,:2])[0]*m['spacingM']
    selected=faces[(distances[faces]<=radius_m).any(axis=1)]
    selected.tofile(work/'upper-faces.i32');m['upperFaceCount']=len(selected);m['upperSearchCorridorRadiusM']=radius_m
    (work/'coarse-witness.json').write_text(json.dumps(w)+'\n')
    (work/'mesh.json').write_text(json.dumps(m,indent=2)+'\n')
    (work/'mesh.txt').write_text(' '.join(str(m[k]) for k in ['vertexCount','upperFaceCount','startIndex','goalIndex','spacingM','oneWayBudgetM','portalElevationStepM'])+'\n')
    print(json.dumps(m),flush=True)


def geometry(points, faces, spacing):
    xyz = points.copy(); xyz[:,:2] *= spacing
    edges = xyz[faces[:,1:]]-xyz[faces[:,0,None]]
    # Horizontal coordinates are (row*s, column*s). Native triangles are right
    # triangles, but the general inverse also makes synthetic tests meaningful.
    inv = np.linalg.inv(edges[:,:,:2])
    grad_z = np.einsum('fij,fj->fi', inv, edges[:,:,2])
    magnitude = np.linalg.norm(grad_z,axis=1)
    uphill = np.zeros_like(grad_z); uphill[:,0] = 1
    np.divide(grad_z, magnitude[:,None], out=uphill, where=magnitude[:,None]>1e-14)
    contour = np.column_stack([-uphill[:,1],uphill[:,0]])
    return inv, grad_z, magnitude, uphill, contour


def support_and_direction(phi, faces, inv, magnitude, uphill, contour, grade_deg):
    """Exact maximum derivative over all unit 3D directions obeying grade cap.

    q is the potential gradient in an orthonormal tangent basis. A direction's
    uphill component is restricted to [-a,a]; maximize q dot direction over
    the two remaining circular arcs. Return horizontal components of a unit
    surface direction attaining that maximum, for optional LP cutting planes.
    """
    diff = phi[faces[:,1:]]-phi[faces[:,0,None]]
    grad = np.einsum('fij,fj->fi', inv, diff)
    stretch = np.sqrt(1+magnitude*magnitude)
    qu = (grad*uphill).sum(axis=1)/stretch
    qv = (grad*contour).sum(axis=1)
    norm = np.hypot(qu,qv)
    sin_alpha = magnitude/stretch
    a = np.ones_like(magnitude)
    np.divide(math.sin(math.radians(grade_deg)),sin_alpha,out=a,where=sin_alpha>0)
    a = np.minimum(a,1)
    unconstrained = np.divide(np.abs(qu),norm,out=np.zeros_like(norm),where=norm>0)<=a
    tu = np.where(unconstrained,np.divide(qu,norm,out=np.zeros_like(norm),where=norm>0),np.sign(qu)*a)
    tv = np.where(unconstrained,np.divide(qv,norm,out=np.zeros_like(norm),where=norm>0),np.where(qv<0,-1.,1.)*np.sqrt(np.maximum(0,1-a*a)))
    support = qu*tu+qv*tv
    horizontal = uphill*(tu/stretch)[:,None]+contour*tv[:,None]
    return support, horizontal


def verified_lower_bound(phi, points, faces, spacing, start, goal, grade_deg, allowance=1e-5):
    inv, _, mag, up, cross = geometry(points,faces,spacing)
    support, _ = support_and_direction(phi,faces,inv,mag,up,cross,grade_deg)
    # A global scaling preserves continuity and makes all face inequalities
    # conservative, including faces that the LP did not constrain tightly.
    scale = max(1.,float(support.max()))*(1+1e-9)
    lower = max(0.,float((phi[start]-phi[goal])/scale)-allowance)
    return lower, scale, float(support.max())


def potential_basis(points, step):
    """Small proposal space; the saved certificate still has every native node.

    Coarse affine functions plus elevation times coarse affine functions capture
    both spatial and contour structure. This restricts proposals, never checks.
    """
    from scipy.sparse import coo_matrix, diags, hstack, eye
    if step==0:return eye(len(points),format='csr')
    r0,c0=points[:,:2].min(axis=0);r1,c1=points[:,:2].max(axis=0)
    nr=math.ceil((r1-r0)/step)+1;nc=math.ceil((c1-c0)/step)+1
    y=(points[:,0]-r0)/step;x=(points[:,1]-c0)/step
    r=np.minimum(np.floor(y).astype(int),nr-2);c=np.minimum(np.floor(x).astype(int),nc-2)
    y-=r;x-=c;first=x+y<=1
    ids=np.where(first[:,None],np.column_stack([r*nc+c,r*nc+c+1,(r+1)*nc+c]),np.column_stack([(r+1)*nc+c+1,(r+1)*nc+c,r*nc+c+1]))
    weights=np.where(first[:,None],np.column_stack([1-x-y,x,y]),np.column_stack([x+y-1,1-x,1-y]))
    basis=coo_matrix((weights.ravel(),(np.repeat(np.arange(len(points)),3),ids.ravel())),shape=(len(points),nr*nc)).tocsr()
    return hstack([basis,diags(points[:,2]-points[:,2].mean())@basis],format='csr')


def solve_lower(grade_deg, max_iterations=80, coarse_step=0):
    if not math.isfinite(grade_deg) or not 0<grade_deg<=20:raise ValueError('Grade cap must be finite and between 0 and 20 degrees')
    import clarabel
    from scipy.sparse import coo_matrix, csc_matrix
    m=json.loads((WORK/'mesh.json').read_text())
    points=np.fromfile(WORK/'vertices.f64','<f8').reshape(-1,3)
    faces=np.fromfile(WORK/'lower-faces.i32','<i4').reshape(-1,3)
    inv,_,mag,up,cross=geometry(points,faces,m['spacingM'])
    basis=potential_basis(points,coarse_step);nc=basis.shape[1];nf=len(faces)
    stretch=np.hypot(1,mag);sin_alpha=mag/stretch;sine=math.sin(math.radians(grade_deg))
    steep=np.flatnonzero(sin_alpha>sine);ns=len(steep);nv=nc+2*ns
    def gradient_matrix(direction):
        coeff=np.einsum('fi,fij->fj',direction,inv)
        values=np.column_stack([-coeff.sum(axis=1),coeff])
        return (coo_matrix((values.ravel(),(np.repeat(np.arange(nf),3),faces.ravel())),shape=(nf,len(points))).tocsr()@basis).tocoo()
    qu=gradient_matrix(up/stretch[:,None]);qv=gradient_matrix(cross)
    # Polar of the tangent unit disk intersected with the grade strip:
    # inf_lambda ||q-lambda*grad(z)|| + sin(theta)*abs(lambda) <= 1.
    # Split lambda into two nonnegative variables. All-heading feasibility is
    # checked again analytically on the saved native potential, independently.
    anchor=basis.getrow(m['goalIndex']).tocoo();offset=1+2*ns
    rows=[np.zeros(len(anchor.data),int),1+np.arange(2*ns),offset+3*qu.row+1,offset+3*qv.row+2]
    cols=[anchor.col,nc+np.arange(2*ns),qu.col,qv.col]
    values=[anchor.data,-np.ones(2*ns),-qu.data,-qv.data]
    for sign,base in [(1,0),(-1,ns)]:
        j=nc+base+np.arange(ns)
        rows += [offset+3*steep,offset+3*steep+1]
        cols += [j,j];values += [np.full(ns,sine),sign*sin_alpha[steep]]
    A=coo_matrix((np.concatenate(values),(np.concatenate(rows),np.concatenate(cols))),shape=(offset+3*nf,nv)).tocsc()
    rhs=np.zeros(A.shape[0]);rhs[offset::3]=1
    objective=np.zeros(nv);objective[:nc]=-(basis.getrow(m['startIndex'])-basis.getrow(m['goalIndex'])).toarray().ravel()
    cones=[clarabel.ZeroConeT(1),clarabel.NonnegativeConeT(2*ns)]+[clarabel.SecondOrderConeT(3) for _ in range(nf)]
    settings=clarabel.DefaultSettings();settings.verbose=False;settings.time_limit=180.;settings.max_iter=max_iterations
    settings.tol_gap_abs=1e-5;settings.tol_gap_rel=1e-7;settings.tol_feas=1e-8
    print(json.dumps(dict(gradeDeg=grade_deg,variables=nv,nativeFaces=nf,potentialControls=nc)),flush=True)
    solution=clarabel.DefaultSolver(csc_matrix((nv,nv)),objective,A,rhs,cones,settings).solve()
    controls=np.asarray(solution.x[:nc]);phi=basis@controls
    if not np.isfinite(phi).all():raise RuntimeError('No finite potential proposal')
    lower,scale,worst=verified_lower_bound(phi,points,faces,m['spacingM'],m['startIndex'],m['goalIndex'],grade_deg)
    name=f'potential-{grade_deg:.6f}'
    (phi/scale).astype('<f8').tofile(WORK/(name+'.f64'))
    certificate=dict(gradeDeg=grade_deg,oneWayDistanceLowerM=lower,roundTripDistanceLowerM=2*lower,potentialFile=name+'.f64',faceCount=nf,maxUnscaledSupport=worst,scale=scale,numericalLengthAllowanceM=1e-5,solverStatus=str(solution.status),solverIterations=solution.iterations,potentialBasisStep=coarse_step)
    (WORK/(name+'.json')).write_text(json.dumps(certificate,indent=2)+'\n')
    print(json.dumps(certificate),flush=True)
    return certificate


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--mesh',action='store_true');parser.add_argument('--refine',action='store_true');parser.add_argument('--grade',type=float);parser.add_argument('--witness-grade',action='store_true');parser.add_argument('--iterations',type=int,default=80);parser.add_argument('--coarse-step',type=int,default=0)
    args=parser.parse_args()
    if args.mesh:build_mesh()
    if args.refine:refine_mesh()
    if args.grade is not None:solve_lower(args.grade,args.iterations,args.coarse_step)
    if args.witness_grade:solve_lower(json.loads((WORK/'witness.json').read_text())['gradeCapDeg'],args.iterations,args.coarse_step)
