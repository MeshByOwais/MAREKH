"""Independent full-grid assessment and exact swept-clearance route audit."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image
from validate_routes import check_footprint, close, center, export_review

ROOT=Path(__file__).resolve().parents[1]
TERRAIN=ROOT/'public/sites/columbia-hills/terrain-v1'
PACKAGE=ROOT/'public/sites/columbia-hills/crew-navigation-v1'


def rebuild_assessment(arrays, rules, model, spacing):
    z,slope,coverage,exclusions=arrays;rows,cols=z.shape
    # Independent vectorised least-squares plane fit with a fixed design matrix.
    yy,xx=np.mgrid[-1:2,-1:2];design=np.column_stack([np.ones(9),xx.ravel(),yy.ravel()])
    windows=np.lib.stride_tricks.sliding_window_view(z.astype('float64'),(3,3)).reshape(rows-2,cols-2,9)
    coefs=windows@np.linalg.pinv(design).T;residual=windows-coefs@design.T
    rms=np.full(z.shape,np.nan);maximum=np.full(z.shape,np.nan)
    good=(np.lib.stride_tricks.sliding_window_view(coverage,(3,3))==1).all(axis=(-1,-2)) & np.isfinite(windows).all(axis=-1)
    rms[1:-1,1:-1]=np.where(good,np.sqrt((residual**2).mean(axis=-1)),np.nan)
    maximum[1:-1,1:-1]=np.where(good,np.abs(residual).max(axis=-1),np.nan)
    hazard=(coverage!=1)|(~np.isfinite(z))|(~np.isfinite(slope))|(slope<0)|(slope>rules['routeSlopeLimitDeg'])|(exclusions!=0)|(~np.isfinite(rms))|(rms>model['roughnessRmsLimitM'])|(maximum>model['residualLimitM'])
    radius=model['bodyRadiusM']+model['clearanceMarginM'];extent=math.ceil(radius/spacing)+1
    padded=np.pad(hazard,extent,constant_values=True);blocked=np.zeros(z.shape,dtype=bool)
    for dr in range(-extent,extent+1):
        for dc in range(-extent,extent+1):
            if math.hypot(max(abs(dr)-1,0)*spacing,max(abs(dc)-1,0)*spacing)<=radius:
                blocked|=padded[extent+dr:extent+dr+rows,extent+dc:extent+dc+cols]
    return rms,maximum,hazard,blocked


def height(p,z,coverage):
    row,col=p['row'],p['column'];rows,cols=z.shape
    assert math.isfinite(row) and math.isfinite(col) and 0<=row<=rows-1 and 0<=col<=cols-1
    r=min(math.floor(row),rows-2);c=min(math.floor(col),cols-2);y=row-r;x=col-c
    if x+y<=1:
        rc=[(r,c),(r,c+1),(r+1,c)];weights=[1-x-y,x,y]
    else:
        rc=[(r+1,c+1),(r+1,c),(r,c+1)];weights=[x+y-1,1-x,1-y]
    assert all(coverage[q]==1 and math.isfinite(float(z[q])) for q in rc)
    return sum(float(z[q])*w for q,w in zip(rc,weights)),[r*cols+c for r,c in rc]


def intersects(a,b,west,south,east,north):
    lo,hi=0.,1.
    for p,d,mn,mx in [(a[1],b[1]-a[1],west,east),(a[0],b[0]-a[0],south,north)]:
        if abs(d)<1e-12:
            if p<mn-1e-9 or p>mx+1e-9:return False
        else:
            u,v=(mn-p)/d,(mx-p)/d;lo=max(lo,min(u,v));hi=min(hi,max(u,v))
            if lo>hi+1e-9:return False
    return True


def touched(a,b,shape):
    rows,cols=shape;found=[]
    for r in range(math.floor(min(a[0],b[0])+.5)-1,math.floor(max(a[0],b[0])+.5)+2):
        for c in range(math.floor(min(a[1],b[1])+.5)-1,math.floor(max(a[1],b[1])+.5)+2):
            if intersects(a,b,c-.5,r-.5,c+.5,r+.5):
                assert 0<=r<rows and 0<=c<cols,'Segment touches outside map';found.append((r,c))
    return found


def point_segment_distance(p,a,b):
    v=(b[0]-a[0],b[1]-a[1]);den=v[0]**2+v[1]**2
    t=max(0.,min(1.,((p[0]-a[0])*v[0]+(p[1]-a[1])*v[1])/den)) if den else 0
    return math.dist(p,(a[0]+t*v[0],a[1]+t*v[1]))


def segment_box_distance(a,b,r,c):
    if intersects(a,b,c-.5,r-.5,c+.5,r+.5):return 0.
    corners=[(r-.5,c-.5),(r-.5,c+.5),(r+.5,c-.5),(r+.5,c+.5)]
    distances=[point_segment_distance(q,a,b) for q in corners]
    for p in [a,b]:distances.append(math.hypot(max(r-.5-p[0],0,p[0]-r-.5),max(c-.5-p[1],0,p[1]-c-.5)))
    return min(distances)


def validate_leg(leg,policy,arrays,blocked,hazard,density,t,config):
    z,slope,coverage,_=arrays;spacing=t[1];points=leg['points'];assert points
    rules=config['rules'];radius=config['crewModel']['bodyRadiusM']+config['crewModel']['clearanceMarginM']
    metrics=dict(distanceM=0.,horizontalDistanceM=0.,positiveClimbM=0.,maxSurfaceSlopeDeg=0.,maxAbsGradeDeg=0.,warningEdgeCount=0,cost=0.,estimatedTimeS=None)
    source_cells=set();edges=[];minimum_clearance=math.inf
    for i,p in enumerate(points):
        x,y=center(t,p['row'],p['column']);close(p['eastM'],x);close(p['northM'],y)
        zvalue,support=height(p,z,coverage);close(p['elevationM'],zvalue);assert p['nativeSupportIndices']==support
        r,c=math.floor(p['row']+.5),math.floor(p['column']+.5);assert p['index']==r*z.shape[1]+c
        close(p['surfaceSlopeDeg'],float(slope[r,c]));source_cells.update(divmod(j,z.shape[1]) for j in support)
        grade=0.;surface=float(slope[r,c])
        if i:
            prev=points[i-1];a=(prev['row'],prev['column']);b=(p['row'],p['column']);cells=touched(a,b,z.shape)
            assert cells and all(not blocked[q] for q in cells),'Clearance-inflated cell crossed'
            source_cells.update(cells);surface=max(float(slope[q]) for q in cells)
            h=math.dist(a,b)*spacing;assert h>0
            dz=p['elevationM']-prev['elevationM'];length=math.hypot(h,dz);grade=math.degrees(math.atan2(dz,h))
            assert abs(grade)<=rules['moveGradeLimitDeg']+1e-8
            # Midpoint height verifies that an emitted segment does not bridge a
            # native triangle kink. Exact analytical split, not raster smoothing.
            mid={'row':(a[0]+b[0])/2,'column':(a[1]+b[1])/2}
            close(height(mid,z,coverage)[0],(p['elevationM']+prev['elevationM'])/2)
            interior=touched((mid['row'],mid['column']),(mid['row'],mid['column']),z.shape)
            cost=h if policy=='distance' else h*max(float(density[q]) for q in interior)
            metrics['distanceM']+=length;metrics['horizontalDistanceM']+=h;metrics['positiveClimbM']+=max(0,dz);metrics['cost']+=cost
            metrics['maxAbsGradeDeg']=max(metrics['maxAbsGradeDeg'],abs(grade));metrics['warningEdgeCount']+=surface>rules['warningSlopeDeg']
            # A second geometric test checks the physical swept capsule directly
            # against raw hazard boxes, independently of the inflation mask.
            reach=math.ceil(radius/spacing)+2
            for rr in range(max(0,math.floor(min(a[0],b[0]))-reach),min(z.shape[0],math.ceil(max(a[0],b[0]))+reach+1)):
                for cc in range(max(0,math.floor(min(a[1],b[1]))-reach),min(z.shape[1],math.ceil(max(a[1],b[1]))+reach+1)):
                    if hazard[rr,cc]:
                        clearance=segment_box_distance(a,b,rr,cc)*spacing;minimum_clearance=min(minimum_clearance,clearance)
                        assert clearance>radius-1e-8,'Swept crew footprint intersects a raw hazard'
            edges.append(dict(policy=policy,segment=i,horizontalM=h,distanceM=length,signedGradeDeg=grade,maxSurfaceSlopeDeg=surface))
        assert not blocked[r,c]
        metrics['maxSurfaceSlopeDeg']=max(metrics['maxSurfaceSlopeDeg'],surface)
        close(p['segmentGradeDeg'],grade);close(p['edgeSurfaceSlopeDeg'],surface);close(p['cumulativeDistanceM'],metrics['distanceM']);close(p['cumulativeHorizontalDistanceM'],metrics['horizontalDistanceM'])
    for k,v in metrics.items():
        if v is None:assert leg['metrics'][k] is None
        else:close(leg['metrics'][k],v)
    return metrics,source_cells,edges,minimum_clearance


def validate(export=False):
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    terrain=json.loads((TERRAIN/'manifest.json').read_text());manifest=json.loads((PACKAGE/'manifest.json').read_text())
    config=json.loads((PACKAGE/'config.json').read_text());mission=json.loads((PACKAGE/'mission.json').read_text());result=json.loads((PACKAGE/'routes.json').read_text())
    assert manifest['terrainManifestSha256']==sha(TERRAIN/'manifest.json')
    assert manifest['baselineManifestSha256']==sha(ROOT/'public/sites/columbia-hills/routes-v1/manifest.json')
    for base,m in [(TERRAIN,terrain),(PACKAGE,manifest)]:
        for name,entry in m['assets'].items():assert (base/name).stat().st_size==entry['bytes'] and sha(base/name)==entry['sha256'],name
    assert sha(PACKAGE/'config.json')==sha(ROOT/'config/columbia-hills/crew-navigation-v1.json')==manifest['configSha256']
    for record in [config,mission,result,manifest]:assert record['routeVersion']==config['routeVersion'] and record['datasetVersion']==terrain['datasetVersion']
    assert config['missionType']=='crew-walk' and result['engine']==config['engine']==manifest['engine']=='field-dstar-crew-local-1'
    shape=terrain['rows'],terrain['columns'];t=terrain['transform'];rules=config['rules'];model=config['crewModel']
    assert manifest['rows']==shape[0] and manifest['columns']==shape[1] and manifest['transform']==t and manifest['crsWkt']==terrain['crsWkt']
    arrays=tuple(np.fromfile(TERRAIN/name,dtype=dtype).reshape(shape) for name,dtype in [('elevation.f32','<f4'),('slope-deg.f32','<f4'),('coverage.u8','u1'),('exclusions.u8','u1')])
    rms,maxres,hazard,blocked=rebuild_assessment(arrays,rules,model,t[1])
    stored_rms=np.fromfile(PACKAGE/'roughness-rms.f32',dtype='<f4').reshape(shape);stored_res=np.fromfile(PACKAGE/'residual-max.f32',dtype='<f4').reshape(shape)
    np.testing.assert_allclose(stored_rms,rms,atol=1e-7,rtol=1e-6,equal_nan=True);np.testing.assert_allclose(stored_res,maxres,atol=1e-7,rtol=1e-6,equal_nan=True)
    np.testing.assert_array_equal(np.fromfile(PACKAGE/'hazard.u8',dtype='u1').reshape(shape),hazard)
    np.testing.assert_array_equal(np.fromfile(PACKAGE/'clearance-blocked.u8',dtype='u1').reshape(shape),blocked)
    density=1+rules['gentleWeight']*(arrays[1].astype(float)/rules['routeSlopeLimitDeg'])**2+model['roughnessWeight']*(stored_rms.astype(float)/model['roughnessRmsLimitM'])**2
    source_cells=set()
    for name,limit in [('staging',rules['stagingSlopeLimitDeg']),('approach',rules['routeSlopeLimitDeg'])]:
        source_cells.update(check_footprint(mission[name],config[name],arrays,t,limit))
        for j in mission[name]['cells']:assert not hazard.flat[j],'Endpoint footprint contains raw roughness/slope/coverage hazard'
    assert len(result['routes'])==2 and {r['policy'] for r in result['routes']}=={'distance','terrain'}
    reports=[];edges=[]
    for route in result['routes']:
        assert route['status']=='ok' and route['datasetVersion']==terrain['datasetVersion'] and route['engine']==config['engine']
        assert route['start']==config['staging']['cell'] and route['target']==config['approach']['cell']
        out=route['outbound']['points'];ret=route['returnLeg']['points']
        assert len(out)==len(ret) and [(p['row'],p['column']) for p in out]==[(p['row'],p['column']) for p in ret[::-1]]
        assert {k:out[0][k] for k in ['row','column']}==route['start'] and {k:out[-1][k] for k in ['row','column']}==route['target']
        assert route['scienceWaypointIndex']==len(out)-1;close(route['turnaroundDistanceM'],out[-1]['cumulativeDistanceM'])
        values=[];clearances=[]
        for leg in ['outbound','returnLeg']:
            m,c,e,clearance=validate_leg(route[leg],route['policy'],arrays,blocked,hazard,density,t,config);values.append(m);source_cells.update(c);clearances.append(clearance)
            edges += [dict(leg=leg,**record) for record in e]
        for k in values[0]:
            v=None if k=='estimatedTimeS' else max(x[k] for x in values) if k.startswith('max') else sum(x[k] for x in values)
            if v is None:assert route['metrics'][k] is None
            else:close(route['metrics'][k],v)
        reports.append(dict(policy=route['policy'],checkedEdges=2*(len(out)-1),localSteps=route['localSteps'],metrics=route['metrics'],sweptClearanceStatus='passed',minimumNearbyRawHazardClearanceM=min(clearances) if math.isfinite(min(clearances)) else None,clearanceNote='Null minimum means no raw hazard boxes in the finite audit neighbourhood; the required-radius swept capsule was fully checked.'))
    gdal.UseExceptions()
    source_config=json.loads((ROOT/'config/columbia-hills/sources.json').read_text());x,y,w,h=source_config['cropBounds']['sourcePixelWindow']
    original=gdal.Open(str(ROOT/'data/raw/columbia-hills/DTEEC_001513_1655_001777_1650_U01.IMG')).ReadAsArray(x,y,w,h)
    assert all(float(original[p])==float(arrays[0][p]) for p in source_cells)
    report=dict(schemaVersion=1,status='passed',routeVersion=config['routeVersion'],datasetVersion=terrain['datasetVersion'],engine=config['engine'],missionType='crew-walk',checker='Independent Python full-grid least-squares terrain fit, whole-cell inflation and exact segment-to-hazard-box swept-footprint checks; no TypeScript engine imported',hazardCells=int(hazard.sum()),clearanceBlockedCells=int(blocked.sum()),effectiveCrewClearanceRadiusM=model['bodyRadiusM']+model['clearanceMarginM'],sourceCheckedCells=len(source_cells),sourceElevationMaxErrorM=0,routes=reports,estimatedTimeS=None,scope='NASA-publication-based crew adaptation; independently verified native geometry and demo constraints. Field D* repair is tested separately against fresh fields. No claim of NASA flight equivalence, global optimality, subpixel obstacle resolution or human mobility certification.')
    if export:
        export_review(result['routes'],mission,terrain,(*arrays[:3],blocked.astype('uint8')),edges,destination=PACKAGE,title='CREW / FIELD D*')
        ds=ogr.Open(str(PACKAGE/'route-review.gpkg'),1);srs=osr.SpatialReference();srs.ImportFromWkt(terrain['crsWkt']);srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        for name,mask in [('crew_raw_hazards',hazard),('crew_clearance_blocked',blocked)]:
            layer=ds.CreateLayer(name,srs,ogr.wkbPolygon)
            mem=gdal.GetDriverByName('MEM').Create('',shape[1],shape[0],1,gdal.GDT_Byte);mem.SetGeoTransform(t);mem.SetProjection(terrain['crsWkt']);mem.GetRasterBand(1).WriteArray(mask.astype('uint8'))
            gdal.Polygonize(mem.GetRasterBand(1),mem.GetRasterBand(1),layer,-1,[])
        ds=None
        # Separate browser overlay shows full-cell hazard inflation, not just the
        # original manually drawn exclusion polygons.
        rgba=np.zeros((*shape,4),dtype='uint8');rgba[blocked]=[214,86,58,105];rgba[hazard]=[230,45,65,145]
        Image.fromarray(rgba,'RGBA').save(PACKAGE/'crew-clearance.webp',lossless=True)
        (PACKAGE/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
        for name in ['validation.json','route-review.png','route-review.gpkg','route-edges.csv','crew-clearance.webp']:manifest['assets'][name]=dict(bytes=(PACKAGE/name).stat().st_size,sha256=sha(PACKAGE/name))
        (PACKAGE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    else:
        assert json.loads((PACKAGE/'validation.json').read_text())==report
        ds=ogr.Open(str(PACKAGE/'route-review.gpkg'));layer=ds.GetLayerByName('routes');srs=osr.SpatialReference();srs.ImportFromWkt(terrain['crsWkt']);srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        assert layer.GetFeatureCount()==4 and layer.GetSpatialRef().IsSame(srs)
        for feature in layer:
            saved=next(r for r in result['routes'] if r['policy']==feature['policy'])[feature['leg']]['points'];geom=feature.GetGeometryRef();assert geom.GetPointCount()==len(saved)
            for i,p in enumerate(saved):
                for a,b in zip(geom.GetPoint(i),[p['eastM'],p['northM'],p['elevationM']]):close(a,b)
        for name,mask in [('crew_raw_hazards',hazard),('crew_clearance_blocked',blocked)]:
            layer=ds.GetLayerByName(name);assert layer.GetSpatialRef().IsSame(srs)
            close(sum(f.GetGeometryRef().GetArea() for f in layer),float(mask.sum())*t[1]*abs(t[5]))
    print(json.dumps(report,indent=2));return report


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--export',action='store_true');validate(parser.parse_args().export)
