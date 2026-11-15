"""Establish Phase 1 coverage, register the science context, and export review assets."""

import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image, ImageDraw, ImageFont

from site_registration import register_figure

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data/raw/columbia-hills'
WORK = ROOT / 'data/work/columbia-hills/phase1'
PUBLIC = ROOT / 'public/sites/columbia-hills/review'
CONFIG = ROOT / 'config/columbia-hills'
WINDOW = [4390, 5985, 990, 990]
COLORS = {'home': '#72dbef', 'science': '#ffbc5c', 'approach': '#ffffff', 'staging': '#8cffa7'}


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def label_number(text, keyword):
    import re
    return float(re.search(r'^\s*' + keyword + r'\s*=\s*([-\d.]+)', text, re.M).group(1))


def main():
    gdal.UseExceptions()
    WORK.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    inventory = json.loads((CONFIG / 'sources.json').read_text())
    for source in [*inventory['products'], *inventory['references']]:
        target = RAW / source['filename']
        if hashlib.sha256(target.read_bytes()).hexdigest() != source['sha256']:
            raise ValueError(f'Source checksum mismatch: {target.name}')

    dem = gdal.Open(str(RAW / inventory['products'][0]['filename']))
    jp2 = gdal.Open(str(RAW / inventory['products'][1]['filename']))
    # The detached PDS label wraps the JP2 data with the intended Mars mapping.
    ortho = gdal.Open(str(RAW / inventory['products'][2]['filename']))
    transform = dem.GetGeoTransform()
    srs = dem.GetSpatialRef()
    assert np.allclose(transform, ortho.GetGeoTransform(), atol=1e-8, rtol=0)
    assert srs.IsSame(ortho.GetSpatialRef())
    assert [dem.RasterXSize, dem.RasterYSize] == [ortho.RasterXSize, ortho.RasterYSize]
    for name, dataset in [('dtm', dem), ('ortho-jp2-native', jp2), ('ortho-label', ortho)]:
        save_json(WORK / f'{name}-info.json', gdal.Info(dataset, format='json'))
    label = (RAW / inventory['products'][2]['filename']).read_text()
    assert abs(srs.GetSemiMajor() - label_number(label, 'A_AXIS_RADIUS') * 1000) < 1e-6
    assert abs(transform[1] - label_number(label, 'MAP_SCALE')) < 1e-10
    assert abs(srs.GetProjParm('central_meridian') - label_number(label, 'CENTER_LONGITUDE')) < 1e-9
    assert abs(srs.GetProjParm('standard_parallel_1') - label_number(label, 'CENTER_LATITUDE')) < 1e-9
    assert dem.GetRasterBand(1).GetScale() == 1 and dem.GetRasterBand(1).GetOffset() == 0
    gdal.Translate(str(WORK / 'ortho-label.vrt'), ortho, format='VRT')
    (WORK / 'dtm-label.txt').write_bytes((RAW / inventory['products'][0]['filename']).read_bytes()[:26096])
    x0, y0, columns, rows = WINDOW
    opts = {'format': 'GTiff', 'srcWin': WINDOW, 'creationOptions': ['COMPRESS=DEFLATE', 'TILED=YES']}
    elevation = gdal.Translate(str(WORK / 'elevation-review.tif'), dem, **opts)
    optical = gdal.Translate(str(WORK / 'optical-review.tif'), ortho, **opts)
    optical.GetRasterBand(1).SetNoDataValue(0)  # CORE_NULL from the label, absent in GDAL band metadata.
    elevation.GetRasterBand(1).SetUnitType('m')
    elevation.FlushCache()
    optical.FlushCache()
    gt = elevation.GetGeoTransform()
    bounds = [gt[0], gt[3] + rows * gt[5], gt[0] + columns * gt[1], gt[3]]
    height = elevation.ReadAsArray()
    image = optical.ReadAsArray()
    valid = np.isfinite(height) & (height != dem.GetRasterBand(1).GetNoDataValue()) & (image != 0)
    if valid.mean() < 0.99:
        raise ValueError('The proposed mission crop does not have sufficient shared valid coverage')
    hillshade = gdal.DEMProcessing(str(WORK / 'hillshade-review.tif'), elevation, 'hillshade', scale=1, alg='Horn')
    shade = hillshade.ReadAsArray()
    Image.fromarray(image).save(PUBLIC / 'optical.png')
    Image.fromarray(shade).save(PUBLIC / 'hillshade.png')

    # Full product coverage is computed at native resolution, then reduced only for display.
    driver = gdal.GetDriverByName('GTiff')
    coverage = driver.Create(str(WORK / 'shared-coverage.tif'), dem.RasterXSize, dem.RasterYSize, 1,
                             gdal.GDT_Byte, ['COMPRESS=DEFLATE', 'TILED=YES'])
    coverage.SetGeoTransform(transform)
    coverage.SetProjection(srs.ExportToWkt())
    coverage.GetRasterBand(1).SetNoDataValue(0)
    valid_count = 0
    saturated_count = 0
    for row in range(0, dem.RasterYSize, 256):
        count = min(256, dem.RasterYSize - row)
        heights = dem.ReadAsArray(0, row, dem.RasterXSize, count)
        pixels = ortho.ReadAsArray(0, row, ortho.RasterXSize, count)
        mask = np.isfinite(heights) & (heights != dem.GetRasterBand(1).GetNoDataValue()) & (pixels != 0)
        valid_count += int(mask.sum())
        saturated_count += int(((pixels == 1) | (pixels == 255)).sum())
        coverage.GetRasterBand(1).WriteArray(mask.astype('u1'), 0, row)
    coverage.FlushCache()

    figure_prefix = WORK / 'ruff-figure'
    subprocess.run(['pdfimages', '-f', '2', '-l', '2', '-png',
                    str(RAW / 'references/Ruff-2008-2213.pdf'), str(figure_prefix)], check=True, capture_output=True)
    figure = Image.open(WORK / 'ruff-figure-000.png').convert('RGB')
    registration = register_figure(ortho, figure)
    matrix = np.array(registration['figureToRasterAffine'])
    save_json(CONFIG / 'registration.json', registration)

    def pixel_world(point):
        col, row = point
        return [transform[0] + (col + 0.5) * transform[1], transform[3] + (row + 0.5) * transform[5]]

    def figure_world(point):
        return pixel_world(np.array([*point, 1]) @ matrix)

    home_outline = [[270, 85], [296, 58], [365, 53], [421, 60], [456, 85], [479, 120],
                    [490, 145], [478, 190], [452, 229], [416, 252], [370, 278], [321, 288],
                    [282, 280], [263, 249], [247, 211], [252, 160], [252, 114], [270, 85]]
    science = figure_world([515, 177])
    home = figure_world([365, 165])
    approach = [science[0], science[1] - 12]
    staging = pixel_world([4810, 6360])
    features = [
        {'id': 'home-plate', 'name': 'Home Plate (approximate outline)', 'kind': 'home',
         'geometry': {'type': 'Polygon', 'coordinates': [[figure_world(p) for p in home_outline]]},
         'status': 'registered context landmark; outline approximate', 'source': registration['source']},
        {'id': 'science-uncertainty', 'name': 'Gertrude Weise / Kenosha Comets context', 'kind': 'science',
         'geometry': {'type': 'Polygon', 'coordinates': [[[science[0] + 15 * math.cos(a), science[1] + 15 * math.sin(a)] for a in np.linspace(0, 2 * math.pi, 65)]]},
         'center': science, 'relativePlanningBufferM': 15,
         'status': 'approximate source-linked area; not a surveyed sample position',
         'sourceFigurePixel': [515, 177], 'source': registration['source'],
         'uncertaintyNote': '15 m is a conservative local planning buffer, not a confidence interval. Absolute DTM geolocation accuracy is not established.'},
        {'id': 'science-approach', 'name': 'Proposed science approach', 'kind': 'approach',
         'geometry': {'type': 'Point', 'coordinates': approach},
         'status': 'proposed; slope and reachability checks pending',
         'rationale': '12 m south of the registered context marker, inside its planning area; the exact observation point is not used as an approved walking endpoint.'},
        {'id': 'staging-candidate', 'name': 'Candidate staging search area', 'kind': 'staging',
         'geometry': {'type': 'Polygon', 'coordinates': [[[staging[0] + dx, staging[1] + dy] for dx, dy in [(-25, -25), (25, -25), (25, 25), (-25, 25), (-25, -25)]]]},
         'status': 'visual search area only; staging slope, exclusions, footprint and connectivity unverified',
         'rationale': '50 m square northwest of Home Plate, inside observed shared coverage; gives room for candidate evaluation in Phases 2 and 3.'},
    ]
    for feature in features:
        points = [feature['geometry']['coordinates']] if feature['geometry']['type'] == 'Point' else feature['geometry']['coordinates'][0]
        for px, py in points:
            col = int((px - gt[0]) / gt[1]); row = int((py - gt[3]) / gt[5])
            assert 0 <= col < columns and 0 <= row < rows and valid[row, col]

    mission = {
        'schemaVersion': 1, 'siteId': 'columbia-hills', 'datasetVersion': 'coverage-review-1',
        'status': 'phase-1-review', 'crsWkt': srs.ExportToWkt(), 'coordinateUnits': 'm',
        'features': features, 'scienceEvidence': {'observation': 'PIA11758', 'date': '2007-05-21', 'sol': 1202},
        'approvedStagingPoint': None, 'approvedScienceApproach': None,
    }
    save_json(CONFIG / 'mission-review.json', mission)
    save_json(PUBLIC / 'mission-review.json', mission)
    inventory['cropBounds'] = {'order': 'west,south,east,north', 'values': bounds, 'crsWkt': srs.ExportToWkt(), 'sourcePixelWindow': WINDOW}
    inventory['scienceApproach'] = {'coordinates': approach, 'units': 'm', 'status': 'proposed-unverified', 'reference': 'mission-review.json'}
    save_json(CONFIG / 'sources.json', inventory)

    # GIS-ready native-CRS vector layers and exact shared valid footprint.
    gpkg_path = WORK / 'coverage-review.gpkg'
    if gpkg_path.exists():
        ogr.GetDriverByName('GPKG').DeleteDataSource(str(gpkg_path))
    vectors = ogr.GetDriverByName('GPKG').CreateDataSource(str(gpkg_path))
    footprint = vectors.CreateLayer('shared_coverage', srs, ogr.wkbPolygon)
    footprint.CreateField(ogr.FieldDefn('valid', ogr.OFTInteger))
    gdal.Polygonize(coverage.GetRasterBand(1), coverage.GetRasterBand(1), footprint, 0)
    landmarks = vectors.CreateLayer('review_landmarks', srs, ogr.wkbUnknown)
    for field in ['name', 'status', 'source']:
        landmarks.CreateField(ogr.FieldDefn(field, ogr.OFTString))
    for data in features:
        feature = ogr.Feature(landmarks.GetLayerDefn())
        for field in ['name', 'status', 'source']:
            feature.SetField(field, data.get(field, 'MAREKH planning proposal'))
        feature.SetGeometry(ogr.CreateGeometryFromJson(json.dumps(data['geometry'])))
        landmarks.CreateFeature(feature)
    vectors = None

    font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    font = ImageFont.truetype(font_path, 16)
    def overlay(base):
        canvas = Image.fromarray(base).convert('RGB')
        draw = ImageDraw.Draw(canvas)
        def local(p):
            return ((p[0] - gt[0]) / gt[1] - 0.5, (p[1] - gt[3]) / gt[5] - 0.5)
        for feature in features:
            geometry = feature['geometry']; color = COLORS[feature['kind']]
            if geometry['type'] == 'Polygon':
                draw.line([local(p) for p in geometry['coordinates'][0]], fill=color, width=3)
            else:
                x, y = local(geometry['coordinates'])
                draw.line([(x - 6, y), (x + 6, y)], fill=color, width=2)
                draw.line([(x, y - 6), (x, y + 6)], fill=color, width=2)
        draw.line([(35, 45), (35, 20)], fill='white', width=3)
        draw.text((28, 2), 'N', font=font, fill='white', stroke_width=2, stroke_fill='black')
        length = 100 / gt[1]
        draw.line([(30, rows - 40), (30 + length, rows - 40)], fill='white', width=4)
        draw.text((30, rows - 30), '100 m', font=font, fill='white', stroke_width=1, stroke_fill='black')
        draw.rectangle((1, 1, columns - 2, rows - 2), outline=COLORS['home'], width=3)
        return canvas
    for name, raster in [('optical', image), ('hillshade', shade)]:
        annotated = overlay(raster)
        annotated.save(PUBLIC / f'{name}-overlay.png')
        detail = annotated.crop((315, 285, 675, 645))
        pen = ImageDraw.Draw(detail)
        pen.line([(15, 320), (15 + 50 / gt[1], 320)], fill='white', width=3)
        pen.text((15, 330), '50 m', font=font, fill='white', stroke_width=1, stroke_fill='black')
        pen.text((15, 10), 'N ↑', font=font, fill='white', stroke_width=1, stroke_fill='black')
        detail.save(PUBLIC / f'{name}-detail.png')
    overview = ortho.ReadAsArray(buf_xsize=652, buf_ysize=1084)
    mask_overview = coverage.ReadAsArray(buf_xsize=652, buf_ysize=1084)
    preview = np.repeat(overview[:, :, None], 3, axis=2)
    boundary = (mask_overview > 0) & ((np.roll(mask_overview, 1, 0) == 0) | (np.roll(mask_overview, -1, 0) == 0) | (np.roll(mask_overview, 1, 1) == 0) | (np.roll(mask_overview, -1, 1) == 0))
    preview[boundary] = [114, 219, 239]
    overview_image = Image.fromarray(preview)
    draw = ImageDraw.Draw(overview_image)
    draw.rectangle((x0 / dem.RasterXSize * 652, y0 / dem.RasterYSize * 1084,
                    (x0 + columns) / dem.RasterXSize * 652, (y0 + rows) / dem.RasterYSize * 1084), outline='#ffbc5c', width=3)
    overview_image.save(PUBLIC / 'footprint-overview.png')
    geo = srs.CloneGeogCS(); geo.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    to_geo = osr.CoordinateTransformation(srs, geo)
    report = {
        'schemaVersion': 1, 'status': 'phase-1-complete', 'siteId': 'columbia-hills',
        'crsWkt': srs.ExportToWkt(), 'sphereRadiusM': srs.GetSemiMajor(),
        'latitudeType': 'planetocentric', 'longitudeDirection': 'east',
        'elevationReference': 'Mars 2000 equipotential surface (label: Smith et al. 2001)',
        'elevationScale': 1, 'elevationOffset': 0, 'horizontalAndVerticalUnits': 'm',
        'sourceDimensions': [dem.RasterXSize, dem.RasterYSize], 'transform': transform,
        'nativeJp2Transform': jp2.GetGeoTransform(), 'nativeJp2CrsWkt': jp2.GetProjection(),
        'georeferencingDecision': 'Open the detached .LBL with GDAL PDS; do not use the JP2 embedded CRS/transform. PDS label projection and grid match DTM exactly.',
        'labelGridOffsetM': [jp2.GetGeoTransform()[0] - transform[0], jp2.GetGeoTransform()[3] - transform[3]],
        'sharedValidSourceCells': valid_count, 'sourceCells': dem.RasterXSize * dem.RasterYSize,
        'opticalSaturatedPixels': saturated_count,
        'opticalCoverageRule': 'DN 0 is unknown (CORE_NULL); DN 1 and 255 are saturation indicators, not measured albedo. Preserve grayscale appearance.',
        'crop': {'sourcePixelWindow': WINDOW, 'boundsWSEN': bounds, 'transform': gt,
                 'sizeM': [columns * gt[1], -rows * gt[5]], 'sharedValidCells': int(valid.sum()),
                 'cells': rows * columns, 'sharedValidFraction': float(valid.mean()),
                 'elevationRangeM': [float(height[valid].min()), float(height[valid].max())]},
        'homePlateApproxLonLat': list(to_geo.TransformPoint(*home)[:2]),
        'scienceContextApproxLonLat': list(to_geo.TransformPoint(*science)[:2]),
        'registration': registration,
        'relativeRegistrationRmsM': registration['fitRmsPixels'] * gt[1],
        'relativeRegistrationLeaveOneOutMaxM': registration['leaveOneOutMaxPixels'] * gt[1],
        'absoluteGeolocationAccuracyM': None,
        'heightImageAlignment': 'Same orthorectified source grid and matching major landforms in optical/hillshade review. No independent ground-control accuracy claim.',
        'approvedStagingPoint': None, 'approvedScienceApproach': None,
        'references': inventory['references'], 'credits': inventory['credits'],
    }
    save_json(CONFIG / 'coverage-review.json', report)
    save_json(PUBLIC / 'coverage-review.json', report)
    print(f'Phase 1 crop: {columns} x {rows} cells; {valid.mean():.2%} shared valid coverage.')
    print(f'Relative image registration RMS: {report["relativeRegistrationRmsM"]:.3f} m; leave-one-out maximum: {report["relativeRegistrationLeaveOneOutMaxM"]:.3f} m.')
    print(f'Home Plate approximate lon/lat: {report["homePlateApproxLonLat"]}')
    print(f'GIS review: {gpkg_path}')


if __name__ == '__main__':
    main()
