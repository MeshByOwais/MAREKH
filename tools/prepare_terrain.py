"""Export the reviewed native HiRISE crop as a versioned analytic terrain package."""

import hashlib
import json
import platform
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config/columbia-hills'
RAW = ROOT / 'data/raw/columbia-hills'
WORK = ROOT / 'data/work/columbia-hills/phase2'
PACKAGE = ROOT / 'public/sites/columbia-hills/terrain-v1'


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def slope_colors(slope, coverage):
    stops = np.array([0, 5, 15, 30, 45, 90])
    colors = np.array([[52, 91, 105], [87, 151, 153], [218, 199, 111], [222, 126, 77], [169, 49, 61], [105, 22, 49]])
    safe = np.nan_to_num(slope, nan=0)
    rgb = np.stack([np.interp(safe, stops, colors[:, channel]) for channel in range(3)], axis=2).astype('u1')
    return np.dstack([rgb, coverage * 255])


def main():
    gdal.UseExceptions()
    WORK.mkdir(parents=True, exist_ok=True)
    PACKAGE.mkdir(parents=True, exist_ok=True)
    source = json.loads((CONFIG / 'sources.json').read_text())
    review = json.loads((CONFIG / 'coverage-review.json').read_text())
    for record in source['products']:
        path = RAW / record['filename']
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != record['sha256']:
            raise ValueError(f'Unverified source: {path.name}')
    dtm = gdal.Open(str(RAW / source['products'][0]['filename']))
    ortho = gdal.Open(str(RAW / source['products'][2]['filename']))
    assert dtm.GetGeoTransform() == ortho.GetGeoTransform()
    assert dtm.GetSpatialRef().IsSame(ortho.GetSpatialRef())
    options = dict(format='GTiff', srcWin=review['crop']['sourcePixelWindow'], creationOptions=['COMPRESS=DEFLATE', 'TILED=YES'])
    dem = gdal.Translate(str(WORK / 'elevation.tif'), dtm, **options)
    image = gdal.Translate(str(WORK / 'optical.tif'), ortho, **options)
    dem.GetRasterBand(1).SetUnitType('m')
    image.GetRasterBand(1).SetNoDataValue(0)
    dem.FlushCache(); image.FlushCache()
    absolute = dem.ReadAsArray()
    known = np.isfinite(absolute) & (absolute != dem.GetRasterBand(1).GetNoDataValue())
    slope_reference = float(np.median(absolute[known]))
    # GDAL 3.8's Horn kernel sums Float32 heights before dividing. A constant
    # recentering avoids cancellation at the negative Mars datum without
    # changing derivatives or the exported original elevation values.
    centered = gdal.GetDriverByName('GTiff').Create(str(WORK / 'slope-input-centered.tif'), dem.RasterXSize, dem.RasterYSize, 1, gdal.GDT_Float32, ['COMPRESS=DEFLATE'])
    centered.SetGeoTransform(dem.GetGeoTransform()); centered.SetProjection(dem.GetProjection())
    centered.GetRasterBand(1).SetNoDataValue(-9999)
    centered.GetRasterBand(1).SetUnitType('m')
    centered.GetRasterBand(1).WriteArray(np.where(known, absolute.astype('f8') - slope_reference, -9999).astype('f4'))
    centered.FlushCache()
    slope_ds = gdal.DEMProcessing(str(WORK / 'slope-deg.tif'), centered, 'slope', format='GTiff', alg='Horn', scale=1, computeEdges=False)
    slope_ds.GetRasterBand(1).SetUnitType('deg')
    hillshade = gdal.DEMProcessing(str(WORK / 'hillshade.tif'), centered, 'hillshade', scale=1, computeEdges=False)
    height = dem.ReadAsArray().astype('<f4')
    slope = slope_ds.ReadAsArray().astype('<f4')
    pixels = image.ReadAsArray()
    height[height == dem.GetRasterBand(1).GetNoDataValue()] = np.nan
    slope[slope == slope_ds.GetRasterBand(1).GetNoDataValue()] = np.nan
    coverage = (np.isfinite(height) & np.isfinite(slope) & (pixels != 0)).astype('u1')
    rows, columns = height.shape
    gt = dem.GetGeoTransform()
    driver = gdal.GetDriverByName('GTiff')
    exclusion_ds = driver.Create(str(WORK / 'exclusions.tif'), columns, rows, 1, gdal.GDT_Byte, ['COMPRESS=DEFLATE'])
    exclusion_ds.SetGeoTransform(gt); exclusion_ds.SetProjection(dem.GetProjection())
    exclusion_ds.GetRasterBand(1).Fill(0)
    exclusion_config = json.loads((CONFIG / 'exclusions.json').read_text())
    shapes = ogr.GetDriverByName('Memory').CreateDataSource('')
    layer = shapes.CreateLayer('exclusions', dem.GetSpatialRef(), ogr.wkbPolygon)
    for entry in exclusion_config['features']:
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetGeometry(ogr.CreateGeometryFromJson(json.dumps(entry['geometry'])))
        layer.CreateFeature(feature)
    gdal.RasterizeLayer(exclusion_ds, [1], layer, burn_values=[1], options=['ALL_TOUCHED=TRUE'])
    exclusions = exclusion_ds.ReadAsArray().astype('u1')
    coverage_ds = driver.Create(str(WORK / 'coverage.tif'), columns, rows, 1, gdal.GDT_Byte, ['COMPRESS=DEFLATE'])
    coverage_ds.SetGeoTransform(gt); coverage_ds.SetProjection(dem.GetProjection())
    coverage_ds.GetRasterBand(1).WriteArray(coverage)
    coverage_ds.GetRasterBand(1).SetNoDataValue(0)
    coverage_ds.FlushCache(); exclusion_ds.FlushCache(); slope_ds.FlushCache()
    for name, array in [('elevation.f32', height), ('slope-deg.f32', slope), ('coverage.u8', coverage), ('exclusions.u8', exclusions)]:
        (PACKAGE / name).write_bytes(array.tobytes(order='C'))
    Image.fromarray(pixels).convert('RGB').save(PACKAGE / 'texture.webp', lossless=True)
    Image.fromarray(hillshade.ReadAsArray()).convert('RGB').save(PACKAGE / 'hillshade.webp', lossless=True)
    Image.fromarray(slope_colors(slope, coverage), 'RGBA').save(PACKAGE / 'slope.webp', lossless=True)
    rgba = np.zeros((rows, columns, 4), dtype='u1')
    rgba[exclusions == 1] = [241, 79, 84, 165]
    Image.fromarray(rgba, 'RGBA').save(PACKAGE / 'exclusions.webp', lossless=True)
    mission = json.loads((CONFIG / 'mission-review.json').read_text())
    mission['datasetVersion'] = 'columbia-hills-terrain-1'
    write_json(PACKAGE / 'mission.json', mission)
    write_json(PACKAGE / 'exclusions.json', exclusion_config)
    preview = Image.new('RGBA', (columns, rows), '#172129')
    preview = Image.alpha_composite(preview, Image.fromarray(slope_colors(slope, coverage), 'RGBA'))
    preview = Image.alpha_composite(preview, Image.fromarray(rgba, 'RGBA'))
    pen = ImageDraw.Draw(preview)
    colors = {'home': '#72dbef', 'science': '#ffbc5c', 'approach': '#ffffff', 'staging': '#8cffa7'}
    def pixel(point):
        return ((point[0] - gt[0]) / gt[1] - 0.5, (point[1] - gt[3]) / gt[5] - 0.5)
    for entry in mission['features']:
        geometry = entry['geometry']; color = colors[entry['kind']]
        if geometry['type'] == 'Polygon':
            pen.line([pixel(p) for p in geometry['coordinates'][0]], fill=color, width=3)
        else:
            x, y = pixel(geometry['coordinates'])
            pen.line([(x - 5, y), (x + 5, y)], fill=color, width=2)
            pen.line([(x, y - 5), (x, y + 5)], fill=color, width=2)
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 18)
    pen.text((20, 12), 'N ↑', font=font, fill='white', stroke_width=1, stroke_fill='black')
    pen.line([(25, rows - 45), (25 + 100 / gt[1], rows - 45)], fill='white', width=4)
    pen.text((25, rows - 35), '100 m', font=font, fill='white', stroke_width=1, stroke_fill='black')
    preview.convert('RGB').save(PACKAGE / 'north-up-validation.png')
    origin = [gt[0] + columns * gt[1] / 2, gt[3] + rows * gt[5] / 2]
    reference = float(np.median(height[coverage == 1]))
    files = ['elevation.f32', 'slope-deg.f32', 'coverage.u8', 'exclusions.u8', 'texture.webp', 'hillshade.webp', 'slope.webp', 'exclusions.webp', 'mission.json', 'exclusions.json', 'north-up-validation.png']
    assets = {name: {'bytes': (PACKAGE / name).stat().st_size, 'sha256': hashlib.sha256((PACKAGE / name).read_bytes()).hexdigest()} for name in files}
    manifest = {
        'schemaVersion': 2, 'datasetVersion': 'columbia-hills-terrain-1', 'siteId': 'columbia-hills',
        'provenance': 'HiRISE stereo-derived elevation and observed orbital imagery',
        'rows': rows, 'columns': columns, 'transform': gt, 'crsWkt': dem.GetProjection(),
        'boundsWSEN': review['crop']['boundsWSEN'], 'localOrigin': {'eastM': origin[0], 'northM': origin[1], 'elevationM': reference},
        'units': {'elevation': 'm', 'slope': 'deg'},
        'storage': {'order': 'row-major', 'floatByteOrder': 'little-endian', 'rowDirection': 'north-to-south'},
        'noData': {'float': 'NaN', 'coverage': '1 means finite elevation, finite native slope and non-null optical image'},
        'elevationReference': review['elevationReference'], 'slopeMethod': {'algorithm': 'Horn', 'scale': 1, 'computeEdges': False, 'resolutionM': gt[1], 'inputElevationOffsetM': slope_reference, 'normalization': 'Subtract a constant from the GDAL slope input to avoid Float32 cancellation; exported heights retain their original datum.'},
        'texture': {'path': 'texture.webp', 'boundsWSEN': review['crop']['boundsWSEN'], 'rows': rows, 'columns': columns, 'appearance': 'lossless grayscale red-band; no colorization', 'productId': source['products'][1]['productId']},
        'render': {'stride': 2, 'verticalScale': 1, 'axes': {'east': '+X', 'up': '+Y', 'north': '-Z'}, 'unknownPolicy': 'Omit a display quad if any native coverage cell inside it is unknown'},
        'exclusions': {'path': 'exclusions.json', 'status': exclusion_config['status'], 'cells': int(exclusions.sum())},
        'statistics': {'validCells': int(coverage.sum()), 'cells': rows * columns, 'elevationMinM': float(np.nanmin(height)), 'elevationMaxM': float(np.nanmax(height)), 'slopeMinDeg': float(np.nanmin(slope)), 'slopeMaxDeg': float(np.nanmax(slope)), 'slopePercentilesDeg': list(map(float, np.nanpercentile(slope, [50, 90, 95, 99])))},
        'sources': source['products'], 'credits': source['credits'],
        'toolchain': {'python': platform.python_version(), 'gdal': gdal.VersionInfo('RELEASE_NAME'), 'numpy': np.__version__},
        'exportVersion': 'prepare-terrain-1', 'assets': assets,
    }
    write_json(PACKAGE / 'manifest.json', manifest)
    print(json.dumps({'package': str(PACKAGE), 'statistics': manifest['statistics'], 'reviewedExclusionCells': int(exclusions.sum())}, indent=2))


if __name__ == '__main__':
    main()
