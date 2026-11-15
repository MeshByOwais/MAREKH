"""Independent continuous-bound and native swept-footprint audit.

Only NumPy/GDAL/Pillow are required: no SciPy, C++ search, or TypeScript code.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from validate_crew_routes import rebuild_assessment, validate_leg
from validate_routes import check_footprint, close, export_review

ROOT=Path(__file__).resolve().parents[1]
TERRAIN=ROOT/'public/sites/columbia-hills/terrain-v1'
CREW=ROOT/'public/sites/columbia-hills/crew-navigation-v1'
PACKAGE=ROOT/'public/sites/columbia-hills/global-grade-v1'


def maximum_derivative(phi,z,spacing,grade_deg):
    """Closed-form all-heading check, independently from LP mesh geometry."""
    # Right triangles on each native square, in TL and BR order.
    def derivatives(values):
        row=np.concatenate([(values[1:,:-1]-values[:-1,:-1]).ravel(),(values[1:,1:]-values[:-1,1:]).ravel()])/spacing
        col=np.concatenate([(values[:-1,1:]-values[:-1,:-1]).ravel(),(values[1:,1:]-values[1:,:-1]).ravel()])/spacing
        return row,col
    zr,zc=derivatives(z);pr,pc=derivatives(phi)
    m=np.hypot(zr,zc);stretch=np.hypot(1,m)
    parallel=np.divide(pr*zr+pc*zc,m*stretch,out=pr.copy(),where=m>1e-14)
    contour=np.divide(pc*zr-pr*zc,m,out=pc.copy(),where=m>1e-14)
    # Broaden the permitted direction set by 1e-10 degree to make the numerical
    # certificate check conservative with respect to the stated grade cap.
    a=np.minimum(1,np.divide(math.sin(math.radians(grade_deg+1e-10))*stretch,m,out=np.ones_like(m),where=m>0))
    norm=np.hypot(parallel,contour)
    free=np.abs(parallel)<=a*norm
    support=np.where(free,norm,a*np.abs(parallel)+np.sqrt(np.maximum(0,1-a*a))*np.abs(contour))
    return float(support.max())


def check_certificate(certificate,phi,z,spacing,start,goal,allowance):
    assert phi.shape==z.shape and np.isfinite(phi).all()
    cap=certificate['gradeDeg'];assert 0<cap<=20
    maximum=maximum_derivative(phi,z,spacing,cap)
    assert maximum<=1-1e-10, ('Potential exceeds continuous-direction limit',maximum)
    assert allowance>=1e-5
    lower=max(0.,float(phi[start]-phi[goal])-allowance)
    close(certificate['oneWayDistanceLowerM'],lower)
    close(certificate['roundTripDistanceLowerM'],2*lower)
    return dict(gradeDeg=cap,oneWayDistanceLowerM=lower,roundTripDistanceLowerM=2*lower,maximumAllowedDirectionalDerivative=maximum,checkedNativeFaces=2*(z.shape[0]-1)*(z.shape[1]-1))


def check_domain(domain,start,goal,spacing,budget,shape):
    r0,r1,c0,c1=domain['bounds']
    assert all(isinstance(v,int) for v in [r0,r1,c0,c1]) and 0<=r0<r1<shape[0] and 0<=c0<c1<shape[1]
    a=budget/(2*spacing);dr,dc=goal[0]-start[0],goal[1]-start[1]
    separation=math.hypot(dr,dc);assert separation<2*a
    b2=a*a-separation*separation/4
    # Axis extrema of ellipse, derived from its quadratic form.
    row_radius=math.sqrt(b2+dr*dr/4);col_radius=math.sqrt(b2+dc*dc/4)
    rm,cm=(start[0]+goal[0])/2,(start[1]+goal[1])/2
    assert r0<rm-row_radius and r1>rm+row_radius and c0<cm-col_radius and c1>cm+col_radius
    assert domain['vertexCount']==(r1-r0+1)*(c1-c0+1)
    assert domain['lowerFaceCount']==2*(r1-r0)*(c1-c0)
    assert domain['startIndex']==(start[0]-r0)*(c1-c0+1)+start[1]-c0
    assert domain['goalIndex']==(goal[0]-r0)*(c1-c0+1)+goal[1]-c0
    close(domain['oneWayBudgetM'],budget);close(domain['spacingM'],spacing)
    return r0,r1,c0,c1


def validate(export=False):
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    terrain=json.loads((TERRAIN/'manifest.json').read_text());manifest=json.loads((PACKAGE/'manifest.json').read_text())
    for base,m in [(TERRAIN,terrain),(PACKAGE,manifest)]:
        for name,entry in m['assets'].items():
            assert '/' not in name and (base/name).stat().st_size==entry['bytes'] and sha(base/name)==entry['sha256'],name
    assert manifest['terrainManifestSha256']==sha(TERRAIN/'manifest.json') and manifest['crewManifestSha256']==sha(CREW/'manifest.json')
    config=json.loads((PACKAGE/'config.json').read_text());mission=json.loads((PACKAGE/'mission.json').read_text());result=json.loads((PACKAGE/'routes.json').read_text());bounds=json.loads((PACKAGE/'bounds.json').read_text());domain=json.loads((PACKAGE/'domain.json').read_text())
    original_config=json.loads((ROOT/'config/columbia-hills/global-grade-v1.json').read_text())
    assert all(config[k]==v for k,v in original_config.items())
    crew=json.loads((CREW/'config.json').read_text())
    for k in ['rules','crewModel','staging','approach']:assert config[k]==crew[k]
    for record in [manifest,config,mission,result]:assert record['datasetVersion']==terrain['datasetVersion'] and record['routeVersion']==config['routeVersion']
    assert manifest['engine']==result['engine']==config['engine']=='continuous-grade-bounds-1'
    assert manifest['configSha256']==sha(PACKAGE/'config.json')
    for k in ['rows','columns','transform','crsWkt']:assert manifest[k]==terrain[k]
    shape=terrain['rows'],terrain['columns'];t=terrain['transform'];rules=config['rules'];model=config['crewModel']
    arrays=tuple(np.fromfile(TERRAIN/name,dtype).reshape(shape) for name,dtype in [('elevation.f32','<f4'),('slope-deg.f32','<f4'),('coverage.u8','u1'),('exclusions.u8','u1')])
    rms,_,hazard,blocked=rebuild_assessment(arrays,rules,model,t[1]);density=1+rules['gentleWeight']*(arrays[1].astype(float)/rules['routeSlopeLimitDeg'])**2+model['roughnessWeight']*(rms/model['roughnessRmsLimitM'])**2
    cells=set()
    for name,limit in [('staging',rules['stagingSlopeLimitDeg']),('approach',rules['routeSlopeLimitDeg'])]:cells.update(check_footprint(mission[name],config[name],arrays,t,limit))
    assert config['roundTripBudgetM']==500 and len(result['routes'])==1
    route=result['routes'][0];assert route['status']=='ok' and route['policy']=='minimax-grade' and route['engine']==config['engine'] and route['datasetVersion']==terrain['datasetVersion']
    assert route['start']==config['staging']['cell'] and route['target']==config['approach']['cell']
    out=route['outbound']['points'];ret=route['returnLeg']['points']
    assert len(out)==len(ret)
    # Re-splitting a reversed continuous segment can round a corner by less
    # than a nanometre. Verify geometry numerically, then audit both legs.
    for p,q in zip(out,ret[::-1]):
        for k in ['row','column']:close(p[k],q[k])
    assert {k:out[0][k] for k in ['row','column']}==route['start'] and {k:out[-1][k] for k in ['row','column']}==route['target']
    assert route['scienceWaypointIndex']==len(out)-1;close(route['turnaroundDistanceM'],route['outbound']['metrics']['distanceM'])
    values=[];edges=[]
    for leg in ['outbound','returnLeg']:
        # Existing independent checker uses horizontal policy cost. Check that
        # on a copy, then check the new 3D objective separately.
        import copy
        checked=copy.deepcopy(route[leg]);checked['metrics']['cost']=checked['metrics']['horizontalDistanceM']
        m,c,e,_=validate_leg(checked,'distance',arrays,blocked,hazard,density,t,config)
        close(route[leg]['metrics']['cost'],m['distanceM']);m['cost']=m['distanceM']
        values.append(m);cells.update(c);edges += [{**record,'policy':route['policy'],'leg':leg} for record in e]
    for k in values[0]:
        v=None if k=='estimatedTimeS' else max(x[k] for x in values) if k.startswith('max') else sum(x[k] for x in values)
        if v is None:assert route['metrics'][k] is None
        else:close(route['metrics'][k],v)
    assert route['metrics']['distanceM']<=config['roundTripBudgetM']
    assert route['metrics']['maxAbsGradeDeg']<=bounds['gradeUpperDeg']+1e-7
    start=tuple(route['start'][k] for k in ['row','column']);goal=tuple(route['target'][k] for k in ['row','column'])
    r0,r1,c0,c1=check_domain(domain,start,goal,t[1],config['roundTripBudgetM']/2,shape)
    surface=arrays[0][r0:r1+1,c0:c1+1].astype(float);assert (arrays[2][r0:r1+1,c0:c1+1]==1).all()
    local_start=start[0]-r0,start[1]-c0;local_goal=goal[0]-r0,goal[1]-c0
    certificates={}
    for name in manifest['assets']:
        if name.startswith('potential-') and name.endswith('.json'):
            cert=json.loads((PACKAGE/name).read_text());phi=np.fromfile(PACKAGE/cert['potentialFile'],'<f8').reshape(surface.shape)
            assert cert['faceCount']==domain['lowerFaceCount']
            assert cert['numericalLengthAllowanceM']==config['numericalLengthAllowanceM']
            certificates[cert['potentialFile']]=check_certificate(cert,phi,surface,t[1],local_start,local_goal,config['numericalLengthAllowanceM'])
    lower=certificates[bounds['gradeLowerCertificate']];secondary=certificates[bounds['secondaryCertificate']]
    assert lower['oneWayDistanceLowerM']>config['roundTripBudgetM']/2
    close(bounds['gradeLowerDeg'],lower['gradeDeg']);close(bounds['gradeUpperDeg'],secondary['gradeDeg']);close(bounds['secondaryGradeCapDeg'],secondary['gradeDeg'])
    assert 0<bounds['gradeLowerDeg']<bounds['gradeUpperDeg']<=rules['moveGradeLimitDeg']
    close(bounds['gradeGapDeg'],bounds['gradeUpperDeg']-bounds['gradeLowerDeg'])
    close(bounds['roundTripBudgetM'],config['roundTripBudgetM'])
    close(bounds['secondaryDistanceLowerM'],secondary['roundTripDistanceLowerM']);close(bounds['secondaryDistanceUpperM'],route['metrics']['distanceM']);close(bounds['secondaryDistanceGapM'],bounds['secondaryDistanceUpperM']-bounds['secondaryDistanceLowerM'])
    assert bounds['secondaryDistanceGapM']>=0 and bounds['exactOptimumClaimed'] is False
    assert bounds['status']=='bounded'
    assert route['optimality']==bounds
    # Check native support against the original IMG independently of the mesh.
    gdal.UseExceptions();source_config=json.loads((ROOT/'config/columbia-hills/sources.json').read_text());x,y,w,h=source_config['cropBounds']['sourcePixelWindow']
    source=gdal.Open(str(ROOT/'data/raw/columbia-hills/DTEEC_001513_1655_001777_1650_U01.IMG')).ReadAsArray(x,y,w,h)
    assert all(float(source[p])==float(arrays[0][p]) for p in cells)
    assert np.array_equal(source[r0:r1+1,c0:c1+1],surface)
    report=dict(schemaVersion=1,status='passed',routeVersion=config['routeVersion'],datasetVersion=terrain['datasetVersion'],engine=config['engine'],bounds=bounds,certificates=list(certificates.values()),sourceCheckedCells=len(cells),certificateSourceCheckedCells=surface.size,sourceElevationMaxErrorM=0,routes=[dict(policy=route['policy'],checkedEdges=2*(len(out)-1),metrics=route['metrics'])],checker='Independent native surface, closed-cell and swept-footprint checks; analytical all-heading potential check on every native triangle. No optimization solver or graph search imported.',scope='Numerical continuous bounds for the stated terrain and static symmetric crew model. Secondary distance at the feasible grade cap; exact optimum not claimed.')
    if export:
        export_review([route],mission,terrain,arrays,edges,destination=PACKAGE,title='CONTINUOUS GRADE BOUNDS',legend_labels=('', 'Lowest peak grade'))
        (PACKAGE/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
        for name in ['validation.json','route-review.gpkg','route-review.png','route-edges.csv']:
            manifest['assets'][name]=dict(bytes=(PACKAGE/name).stat().st_size,sha256=sha(PACKAGE/name))
        (PACKAGE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    else:
        assert json.loads((PACKAGE/'validation.json').read_text())==report
        ds=ogr.Open(str(PACKAGE/'route-review.gpkg'));layer=ds.GetLayerByName('routes');assert layer.GetFeatureCount()==2
        srs=osr.SpatialReference();srs.ImportFromWkt(terrain['crsWkt']);srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        assert layer.GetSpatialRef().IsSame(srs)
        for feature in layer:
            saved=route[feature['leg']]['points'];geom=feature.GetGeometryRef();assert len(saved)==geom.GetPointCount()
            for i,p in enumerate(saved):
                for a,b in zip(geom.GetPoint(i),[p['eastM'],p['northM'],p['elevationM']]):close(a,b)
    print(json.dumps(report,indent=2));return report


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--export',action='store_true');validate(parser.parse_args().export)
