"""Build a synthetic terrain package to exercise the real raster toolchain."""

import hashlib
import json
import platform
from pathlib import Path

try:
    import numpy as np
    from osgeo import gdal, osr
except ImportError as exc:
    raise SystemExit(
        'Use COLUMBIA_GDAL_PYTHON to select Python with NumPy and GDAL bindings.'
    ) from exc

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'data/work/columbia-hills/synthetic'
PACKAGE = ROOT / 'public/sites/columbia-hills/synthetic'
ROWS, COLS = 9, 11
TRANSFORM = (0.0, 5.0, 0.0, 0.0, 0.0, -5.0)
NODATA = -9999.0

def main() -> None:
    gdal.UseExceptions()
    WORK.mkdir(parents=True, exist_ok=True)
    PACKAGE.mkdir(parents=True, exist_ok=True)

    crs = osr.SpatialReference()
    crs.SetFromUserInput('+proj=eqc +a=3396190 +b=3396190 +units=m +type=crs')
    _, cols = np.indices((ROWS, COLS))
    elevation = (100 + cols * 2.5).astype('<f4')
    elevation[4, 5] = NODATA
    dem = gdal.GetDriverByName('GTiff').Create(
        str(WORK / 'elevation.tif'), COLS, ROWS, 1, gdal.GDT_Float32
    )
    dem.SetGeoTransform(TRANSFORM)
    dem.SetProjection(crs.ExportToWkt())
    band = dem.GetRasterBand(1)
    band.SetNoDataValue(NODATA)
    band.SetUnitType('m')
    band.WriteArray(elevation)
    band.FlushCache()
    band = None
    dem = None

    slope_ds = gdal.DEMProcessing(
        str(WORK / 'slope-deg.tif'), str(WORK / 'elevation.tif'), 'slope',
        format='GTiff', alg='Horn', scale=1, computeEdges=False,
    )
    slope_band = slope_ds.GetRasterBand(1)
    slope = slope_band.ReadAsArray().astype('<f4')
    coverage = ((elevation != NODATA) & (slope != slope_band.GetNoDataValue())).astype('u1')
    slope_band = None
    slope_ds = None

    arrays = {
        'elevation.f32': elevation,
        'slope-deg.f32': slope,
        'coverage.u8': coverage,
        'exclusions.u8': np.zeros_like(coverage),
    }
    assets = {}
    for filename, array in arrays.items():
        content = array.tobytes(order='C')
        (PACKAGE / filename).write_bytes(content)
        assets[filename] = {
            'bytes': len(content),
            'sha256': hashlib.sha256(content).hexdigest(),
        }

    manifest = {
        'schemaVersion': 1,
        'datasetVersion': 'synthetic-plane-1',
        'siteId': 'columbia-hills',
        'provenance': 'synthetic',
        'rows': ROWS,
        'columns': COLS,
        'transform': TRANSFORM,
        'crsWkt': crs.ExportToWkt(),
        'units': {'elevation': 'm', 'slope': 'deg'},
        'storage': {'order': 'row-major', 'floatByteOrder': 'little-endian'},
        'assets': assets,
    }
    (PACKAGE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared synthetic terrain with {int(coverage.sum())} valid cells of {ROWS * COLS}.')
    print(f'Python {platform.python_version()}, GDAL {gdal.VersionInfo("RELEASE_NAME")}, NumPy {np.__version__}.')

if __name__ == '__main__':
    main()
