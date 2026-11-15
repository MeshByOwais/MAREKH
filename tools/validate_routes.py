"""Independent native-grid route audit and Mars-CRS GIS export; does not call A*."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TERRAIN = ROOT / 'public/sites/columbia-hills/terrain-v1'
PACKAGE = ROOT / 'public/sites/columbia-hills/routes-v1'


def close(actual, expected):
    assert isinstance(actual, (float, int)) and math.isfinite(actual)
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-8), (actual, expected)


def center(t, row, col):
    return t[0] + (col + .5) * t[1] + (row + .5) * t[2], t[3] + (col + .5) * t[4] + (row + .5) * t[5]


def check_edge(a, b, arrays, t, rules):
    z, slope, coverage, exclusions = arrays
    rows, cols = z.shape
    ar, ac = a; br, bc = b
    assert all(isinstance(v, int) for v in [ar, ac, br, bc])
    assert 0 <= ar < rows and 0 <= br < rows and 0 <= ac < cols and 0 <= bc < cols
    dr, dc = br - ar, bc - ac
    assert max(abs(dr), abs(dc)) == 1, 'Non-neighbour edge'
    crossed = [a, b] + ([(ar, bc), (br, ac)] if dr and dc else [])
    for r, c in crossed:
        assert coverage[r, c] == 1 and exclusions[r, c] == 0, 'Unknown or excluded crossed cell'
        assert math.isfinite(float(z[r, c])) and 0 <= slope[r, c] <= rules['routeSlopeLimitDeg'], 'Blocked surface slope'
    pa, pb = center(t, ar, ac), center(t, br, bc)
    horizontal = math.dist(pa, pb)
    dz = float(z[b]) - float(z[a])
    grade = math.degrees(math.atan2(dz, horizontal))
    assert abs(grade) <= rules['moveGradeLimitDeg'], 'Move grade exceeds limit'
    if dr and dc:
        for side in crossed[2:]:
            for endpoint in [a, b]:
                side_grade = math.degrees(math.atan2(float(z[side]) - float(z[endpoint]), math.dist(center(t, *side), center(t, *endpoint))))
                assert abs(side_grade) <= rules['moveGradeLimitDeg'], 'Diagonal cardinal transition exceeds limit'
    return horizontal, math.hypot(horizontal, dz), grade, max(float(slope[p]) for p in crossed), max(0, dz), crossed


def check_leg(leg, policy, arrays, t, rules):
    points = leg['points']; assert points
    z, slope, coverage, exclusions = arrays
    metrics = dict(distanceM=0., horizontalDistanceM=0., positiveClimbM=0., maxSurfaceSlopeDeg=0., maxAbsGradeDeg=0., warningEdgeCount=0, cost=0., estimatedTimeS=None)
    crossed_cells = set()
    edges = []
    for i, p in enumerate(points):
        r, c = p['row'], p['column']
        assert isinstance(r, int) and isinstance(c, int) and 0 <= r < z.shape[0] and 0 <= c < z.shape[1]
        assert p['index'] == r * z.shape[1] + c
        assert coverage[r, c] == 1 and exclusions[r, c] == 0 and math.isfinite(float(z[r, c]))
        assert 0 <= slope[r, c] <= rules['routeSlopeLimitDeg']
        east, north = center(t, r, c)
        for key, value in [('eastM', east), ('northM', north), ('elevationM', float(z[r, c])), ('surfaceSlopeDeg', float(slope[r, c]))]: close(p[key], value)
        grade, surface = 0., float(slope[r, c])
        crossed_cells.add((r, c))
        if i:
            prev = points[i - 1]
            h, length, grade, surface, climb, crossed = check_edge((prev['row'], prev['column']), (r, c), arrays, t, rules)
            metrics['distanceM'] += length; metrics['horizontalDistanceM'] += h; metrics['positiveClimbM'] += climb
            metrics['maxAbsGradeDeg'] = max(metrics['maxAbsGradeDeg'], abs(grade))
            metrics['warningEdgeCount'] += surface > rules['warningSlopeDeg']
            metrics['cost'] += length * (1 + rules['gentleWeight'] * (surface / rules['routeSlopeLimitDeg']) ** 2 if policy == 'gentle' else 1)
            crossed_cells.update(crossed)
            edges.append(dict(segment=i, horizontalM=h, distanceM=length, signedGradeDeg=grade, maxSurfaceSlopeDeg=surface))
        metrics['maxSurfaceSlopeDeg'] = max(metrics['maxSurfaceSlopeDeg'], surface)
        close(p['cumulativeDistanceM'], metrics['distanceM']); close(p['cumulativeHorizontalDistanceM'], metrics['horizontalDistanceM'])
        close(p['segmentGradeDeg'], grade); close(p['edgeSurfaceSlopeDeg'], surface)
    for key, value in metrics.items():
        if value is None: assert leg['metrics'][key] is None
        else: close(leg['metrics'][key], value)
    return metrics, crossed_cells, edges


def check_footprint(record, spec, arrays, t, limit):
    z, slope, coverage, exclusions = arrays
    p = center(t, spec['cell']['row'], spec['cell']['column'])
    close(record['eastM'], p[0]); close(record['northM'], p[1])
    bounds = [p[0] - spec['footprintWidthM']/2, p[1] - spec['footprintHeightM']/2, p[0] + spec['footprintWidthM']/2, p[1] + spec['footprintHeightM']/2]
    for a, b in zip(record['boundsWSEN'], bounds): close(a, b)
    assert t[2] == t[4] == 0 and t[1] > 0 and t[5] < 0
    # Inverse map continuous footprint edges to touched closed raster boxes.
    c0 = math.ceil((bounds[0]-t[0])/t[1]) - 1; c1 = math.floor((bounds[2]-t[0])/t[1])
    r0 = math.ceil((bounds[3]-t[3])/t[5]) - 1; r1 = math.floor((bounds[1]-t[3])/t[5])
    assert 0 <= r0 <= r1 < z.shape[0] and 0 <= c0 <= c1 < z.shape[1]
    cells = [(r, c) for r in range(r0, r1+1) for c in range(c0, c1+1)]
    assert record['cells'] == [r*z.shape[1]+c for r, c in cells] and record['cellCount'] == len(cells)
    for r, c in cells:
        assert coverage[r, c] == 1 and exclusions[r, c] == 0
        assert math.isfinite(float(z[r, c])) and 0 <= slope[r, c] <= limit
    close(record['maxSlopeDeg'], max(float(slope[p]) for p in cells)); close(record['slopeLimitDeg'], limit)
    close(record['elevationM'], float(z[spec['cell']['row'], spec['cell']['column']]))
    assert record['cell'] == spec['cell']
    expected_ring = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]]]
    assert record['geometry'] == {'type': 'Polygon', 'coordinates': [expected_ring]}
    return set(cells)


def export_review(routes, mission, terrain, arrays, edges, destination=PACKAGE, title='PHASE 3', legend_labels=None):
    ogr.UseExceptions(); srs = osr.SpatialReference(); srs.ImportFromWkt(terrain['crsWkt'])
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dest = destination/'route-review.gpkg'
    if dest.exists(): dest.unlink()
    ds = ogr.GetDriverByName('GPKG').CreateDataSource(str(dest))
    def layer(name, geometry_type):
        out = ds.CreateLayer(name, srs, geometry_type)
        for field in ['policy', 'leg', 'name']: out.CreateField(ogr.FieldDefn(field, ogr.OFTString))
        for field in ['distance_m', 'climb_m', 'slope_deg', 'grade_deg']: out.CreateField(ogr.FieldDefn(field, ogr.OFTReal))
        return out
    def add(out, geometry, attrs):
        f = ogr.Feature(out.GetLayerDefn()); f.SetGeometry(geometry)
        for k, v in attrs.items(): f.SetField(k, v)
        out.CreateFeature(f)
    lines = layer('routes', ogr.wkbLineString25D)
    for route in routes:
        for leg in ['outbound', 'returnLeg']:
            geometry = ogr.Geometry(ogr.wkbLineString25D)
            for p in route[leg]['points']: geometry.AddPoint(p['eastM'], p['northM'], p['elevationM'])
            m = route[leg]['metrics']
            add(lines, geometry, dict(policy=route['policy'], leg=leg, distance_m=m['distanceM'], climb_m=m['positiveClimbM'], slope_deg=m['maxSurfaceSlopeDeg'], grade_deg=m['maxAbsGradeDeg']))
    footprints = layer('endpoint_footprints', ogr.wkbPolygon)
    endpoints = layer('endpoints', ogr.wkbPoint25D)
    for name in ['staging', 'approach']:
        record = mission[name]
        add(footprints, ogr.CreateGeometryFromJson(json.dumps(record['geometry'])), {'name': name})
        p = ogr.Geometry(ogr.wkbPoint25D); p.AddPoint(record['eastM'], record['northM'], record['elevationM'])
        add(endpoints, p, {'name': name})
    original = json.loads((TERRAIN/'mission.json').read_text())
    context = layer('source_context', ogr.wkbUnknown)
    for f in original['features']: add(context, ogr.CreateGeometryFromJson(json.dumps(f['geometry'])), {'name': f['id']})
    excluded_layer = layer('reviewed_exclusions', ogr.wkbPolygon)
    for f in json.loads((TERRAIN/'exclusions.json').read_text())['features']:
        add(excluded_layer, ogr.CreateGeometryFromJson(json.dumps(f['geometry'])), {'name': f['id']})
    # Native shared coverage perimeter (the one-cell unknown ring is excluded).
    coverage_layer = ds.CreateLayer('native_valid_footprint', srs, ogr.wkbPolygon)
    mem = gdal.GetDriverByName('MEM').Create('', terrain['columns'], terrain['rows'], 1, gdal.GDT_Byte)
    mem.SetGeoTransform(terrain['transform']); mem.SetProjection(terrain['crsWkt']); mem.GetRasterBand(1).WriteArray(arrays[2])
    gdal.Polygonize(mem.GetRasterBand(1), mem.GetRasterBand(1), coverage_layer, -1, [], callback=None)
    ds = None
    with (destination/'route-edges.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=['policy', 'leg', 'segment', 'horizontalM', 'distanceM', 'signedGradeDeg', 'maxSurfaceSlopeDeg']); writer.writeheader(); writer.writerows(edges)

    t = terrain['transform']
    def pixel(e, n): return (e-t[0])/t[1]-.5, (n-t[3])/t[5]-.5
    im = Image.open(TERRAIN/'texture.webp').convert('RGB')
    overlay = Image.new('RGBA', im.size); d = ImageDraw.Draw(overlay)
    excluded = np.where(arrays[3] == 1, 100, 0).astype('uint8')
    red = Image.new('RGBA', im.size, (225,45,60,0)); red.putalpha(Image.fromarray(excluded)); overlay.alpha_composite(red)
    d = ImageDraw.Draw(overlay)
    for f in original['features']:
        if f['geometry']['type'] == 'Polygon':
            d.line([pixel(*p) for p in f['geometry']['coordinates'][0]], fill={'home':'#72dbef','science':'#ffbc5c','staging':'#8cffa7'}[f['kind']], width=1)
    for route in routes:
        d.line([pixel(p['eastM'], p['northM']) for p in route['outbound']['points']], fill='#ffe26c' if route['policy'] in ['shortest','distance'] else '#29e6b6', width=2)
    for name in ['staging', 'approach']:
        p = mission[name]; d.line([pixel(*p) for p in p['geometry']['coordinates'][0]], fill='white', width=1)
        x,y = pixel(p['eastM'], p['northM']); d.ellipse((x-2,y-2,x+2,y+2), fill='white')
    im = Image.alpha_composite(im.convert('RGBA'), overlay).convert('RGB')
    # Context extent includes routes, Home Plate and the complete candidate square.
    im = im.crop((370,335,590,550)).resize((880,860), Image.Resampling.NEAREST)
    out = Image.new('RGB', (960,1010), '#10171d'); out.paste(im,(40,90)); d = ImageDraw.Draw(out)
    d.text((40,20),f'MAREKH / {title} / COLUMBIA HILLS',fill='white')
    d.text((40,43),'Native orbital image + independently checked route edges / N up',fill='#b4c3cc')
    d.text((52,100),'N',fill='white'); d.line((57,145,57,120),fill='white',width=2)
    d.line((55,925,55+round(20/t[1]*4),925),fill='white',width=3); d.text((55,905),'20 m',fill='white')
    crew=routes[0]['policy']=='distance'
    labels=legend_labels or ('Distance priority' if crew else 'Shortest', 'Terrain priority' if crew else 'Gentler terrain')
    if labels[0]:
        d.line((40,975,75,975), fill='#ffe26c',width=3); d.text((85,969),labels[0], fill='white')
    if labels[1]:
        d.line((235,975,270,975), fill='#29e6b6',width=3); d.text((280,969),labels[1], fill='white')
    d.text((490,969),'White: checked staging / approach footprints',fill='white')
    out.save(destination/'route-review.png')


def validate(export=False):
    terrain = json.loads((TERRAIN/'manifest.json').read_text()); manifest = json.loads((PACKAGE/'manifest.json').read_text())
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    assert manifest['terrainManifestSha256'] == sha(TERRAIN/'manifest.json')
    for base, m in [(TERRAIN, terrain), (PACKAGE, manifest)]:
        for name, entry in m['assets'].items():
            assert (base/name).stat().st_size == entry['bytes'] and sha(base/name) == entry['sha256'], name
    assert manifest['configSha256'] == sha(PACKAGE/'config.json') == sha(ROOT/'config/columbia-hills/routing-v1.json')
    config = json.loads((PACKAGE/'config.json').read_text()); mission = json.loads((PACKAGE/'mission.json').read_text()); result = json.loads((PACKAGE/'routes.json').read_text())
    assert manifest['crsWkt'] == terrain['crsWkt']
    for record in [manifest, config, mission, result]:
        assert record['datasetVersion'] == terrain['datasetVersion'] and record['routeVersion'] == config['routeVersion']
    shape = terrain['rows'], terrain['columns']; t = terrain['transform']; rules = config['rules']
    arrays = tuple(np.fromfile(TERRAIN/name,dtype=dtype).reshape(shape) for name,dtype in [('elevation.f32','<f4'),('slope-deg.f32','<f4'),('coverage.u8','u1'),('exclusions.u8','u1')])
    touched = set()
    for name, limit in [('staging',rules['stagingSlopeLimitDeg']),('approach',rules['routeSlopeLimitDeg'])]:
        touched.update(check_footprint(mission[name],config[name],arrays,t,limit))
    context = json.loads((TERRAIN/'mission.json').read_text())
    search = next(f for f in context['features'] if f['id']=='staging-candidate')['geometry']['coordinates'][0]
    bx,by = zip(*search); b = mission['staging']['boundsWSEN']
    assert min(bx) <= b[0] <= b[2] <= max(bx) and min(by) <= b[1] <= b[3] <= max(by)
    science = next(f for f in context['features'] if f['id']=='science-uncertainty')
    assert math.dist([mission['approach']['eastM'],mission['approach']['northM']],science['center']) <= science['relativePlanningBufferM']
    proposal = next(f for f in context['features'] if f['id']=='science-approach')['geometry']['coordinates']
    assert mission['approach']['originalProposalEastNorthM'] == config['approach']['proposedEastNorthM'] == proposal
    close(mission['approach']['adoptedCenterDisplacementM'],math.dist(proposal,[mission['approach']['eastM'],mission['approach']['northM']]))
    assert {r['policy'] for r in result['routes']} == {'shortest','gentle'} and len(result['routes']) == 2
    reports = []; all_edges = []
    for route in result['routes']:
        assert route['status'] == 'ok' and route['datasetVersion'] == terrain['datasetVersion']
        assert route['start'] == config['staging']['cell'] and route['target'] == config['approach']['cell']
        out, ret = route['outbound']['points'],route['returnLeg']['points']
        assert [(p['row'],p['column']) for p in out] == [(p['row'],p['column']) for p in reversed(ret)]
        assert {k:out[0][k] for k in ['row','column']} == route['start'] and {k:out[-1][k] for k in ['row','column']} == route['target']
        assert route['scienceWaypointIndex'] == len(out)-1; close(route['turnaroundDistanceM'],out[-1]['cumulativeDistanceM'])
        values = []
        for leg in ['outbound','returnLeg']:
            metrics,cells,edges = check_leg(route[leg],route['policy'],arrays,t,rules); touched.update(cells); values.append(metrics)
            all_edges += [dict(policy=route['policy'],leg=leg,**e) for e in edges]
        for key in values[0]:
            expected = None if key=='estimatedTimeS' else (max(v[key] for v in values) if key.startswith('max') else sum(v[key] for v in values))
            if expected is None: assert route['metrics'][key] is None
            else: close(route['metrics'][key],expected)
        reports.append(dict(policy=route['policy'],checkedEdges=2*(len(out)-1),outboundPoints=len(out),metrics=route['metrics']))
    # Check all route-supercover and endpoint-footprint heights against the original IMG.
    gdal.UseExceptions(); source = gdal.Open(str(ROOT/'data/raw/columbia-hills/DTEEC_001513_1655_001777_1650_U01.IMG'))
    source_config = json.loads((ROOT/'config/columbia-hills/sources.json').read_text())
    x,y,w,h = source_config['cropBounds']['sourcePixelWindow']; original = source.ReadAsArray(x,y,w,h)
    assert all(float(original[p]) == float(arrays[0][p]) for p in touched)
    report = dict(schemaVersion=1,status='passed',routeVersion=config['routeVersion'],datasetVersion=terrain['datasetVersion'],checker='Independent Python geometry, native-array and source-IMG audit; routing engine not imported',sourceElevationMaxErrorM=0,uniqueSourceCheckedCells=len(touched),stagingCellCount=mission['staging']['cellCount'],stagingMaxSlopeDeg=mission['staging']['maxSlopeDeg'],approachCellCount=mission['approach']['cellCount'],approachCenterDisplacementM=mission['approach']['adoptedCenterDisplacementM'],routes=reports,estimatedTimeS=None,absoluteGeolocationAccuracyM=None,scope='Every route edge, supercover side cell, diagonal side grade, endpoint footprint, signed grade, cumulative distance, cost, climb, turnaround and return closure. Optimality is separately tested against reference Dijkstra on fixtures; no claim of operational safety.')
    if export:
        export_review(result['routes'],mission,terrain,arrays,all_edges)
        (PACKAGE/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
        for name in ['validation.json','route-review.gpkg','route-edges.csv','route-review.png']:
            manifest['assets'][name] = dict(bytes=(PACKAGE/name).stat().st_size,sha256=sha(PACKAGE/name))
        (PACKAGE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    else:
        assert json.loads((PACKAGE/'validation.json').read_text()) == report
        # Confirm exported GIS routes retain the native Mars CRS and all vertices.
        ds = ogr.Open(str(PACKAGE/'route-review.gpkg')); lines = ds.GetLayerByName('routes')
        srs = osr.SpatialReference(); srs.ImportFromWkt(terrain['crsWkt']); srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        assert lines.GetSpatialRef().IsSame(srs) and lines.GetFeatureCount() == 4
        for f in lines:
            expected = next(r for r in result['routes'] if r['policy']==f['policy'])[f['leg']]['points']; g=f.GetGeometryRef()
            assert g.GetPointCount()==len(expected)
            for i,p in enumerate(expected):
                for a,b in zip(g.GetPoint(i),[p['eastM'],p['northM'],p['elevationM']]): close(a,b)
        footprints=ds.GetLayerByName('endpoint_footprints'); endpoints=ds.GetLayerByName('endpoints')
        assert footprints.GetFeatureCount()==endpoints.GetFeatureCount()==2
        for f in footprints:
            assert f.GetGeometryRef().Equals(ogr.CreateGeometryFromJson(json.dumps(mission[f['name']]['geometry'])))
        for f in endpoints:
            record=mission[f['name']]
            for a,b in zip(f.GetGeometryRef().GetPoint(),[record['eastM'],record['northM'],record['elevationM']]): close(a,b)
        footprint_layer=ds.GetLayerByName('native_valid_footprint')
        close(sum(f.GetGeometryRef().GetArea() for f in footprint_layer),float(arrays[2].sum())*abs(t[1]*t[5]-t[2]*t[4]))
        excluded_layer=ds.GetLayerByName('reviewed_exclusions')
        excluded_features=json.loads((TERRAIN/'exclusions.json').read_text())['features']
        assert excluded_layer.GetFeatureCount()==len(excluded_features)
        for f in excluded_layer:
            expected=next(e for e in excluded_features if e['id']==f['name'])
            assert f.GetGeometryRef().Equals(ogr.CreateGeometryFromJson(json.dumps(expected['geometry'])))
        with (PACKAGE/'route-edges.csv').open() as f:
            records=list(csv.DictReader(f)); assert len(records)==len(all_edges)
            for a,b in zip(records,all_edges):
                for k,v in b.items():
                    if isinstance(v,str): assert a[k]==v
                    else: close(float(a[k]),v)
    print(json.dumps(report,indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--export',action='store_true')
    validate(parser.parse_args().export)
