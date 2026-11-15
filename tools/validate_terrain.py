"""Independent full-grid checks for the Phase 2 browser terrain package."""

import hashlib
import json
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'public/sites/columbia-hills/terrain-v1'


def validate():
    gdal.UseExceptions()
    manifest = json.loads((PACKAGE / 'manifest.json').read_text())
    assert manifest['schemaVersion'] == 2 and manifest['render']['verticalScale'] == 1
    assert manifest['units'] == {'elevation': 'm', 'slope': 'deg'}
    assert manifest['storage']['floatByteOrder'] == 'little-endian'
    for name, entry in manifest['assets'].items():
        data = (PACKAGE / name).read_bytes()
        assert len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256'], name
    shape = manifest['rows'], manifest['columns']
    z = np.fromfile(PACKAGE / 'elevation.f32', dtype='<f4').reshape(shape)
    slope = np.fromfile(PACKAGE / 'slope-deg.f32', dtype='<f4').reshape(shape)
    coverage = np.fromfile(PACKAGE / 'coverage.u8', dtype='u1').reshape(shape)
    exclusions = np.fromfile(PACKAGE / 'exclusions.u8', dtype='u1').reshape(shape)
    assert set(np.unique(coverage)) <= {0, 1} and set(np.unique(exclusions)) <= {0, 1}
    assert np.isfinite(z[coverage == 1]).all() and np.isfinite(slope[coverage == 1]).all()
    assert coverage.sum() == manifest['statistics']['validCells']
    assert not coverage[0].any() and not coverage[-1].any() and not coverage[:, 0].any() and not coverage[:, -1].any()
    assert np.isnan(slope[0]).all() and np.isnan(slope[:, 0]).all()
    assert exclusions.sum() == manifest['exclusions']['cells']
    source = gdal.Open(str(ROOT / 'data/raw/columbia-hills/DTEEC_001513_1655_001777_1650_U01.IMG'))
    config = json.loads((ROOT / 'config/columbia-hills/sources.json').read_text())
    x, y, columns, rows = config['cropBounds']['sourcePixelWindow']
    original = source.ReadAsArray(x, y, columns, rows)
    np.testing.assert_array_equal(z, original)
    native_optical = gdal.Open(str(ROOT / 'data/work/columbia-hills/phase2/optical.tif')).ReadAsArray()
    texture = np.asarray(Image.open(PACKAGE / 'texture.webp').convert('RGB'))
    for channel in range(3):
        np.testing.assert_array_equal(texture[:, :, channel], native_optical)
    # Independent double-precision Horn derivatives over the native grid.
    a = z.astype('f8')
    dx, dy = manifest['transform'][1], abs(manifest['transform'][5])
    gx = ((a[:-2, 2:] + 2 * a[1:-1, 2:] + a[2:, 2:]) - (a[:-2, :-2] + 2 * a[1:-1, :-2] + a[2:, :-2])) / (8 * dx)
    gy = ((a[2:, :-2] + 2 * a[2:, 1:-1] + a[2:, 2:]) - (a[:-2, :-2] + 2 * a[:-2, 1:-1] + a[:-2, 2:])) / (8 * dy)
    expected = np.degrees(np.arctan(np.hypot(gx, gy)))
    slope_error = float(np.max(np.abs(expected - slope[1:-1, 1:-1])))
    assert slope_error < 1e-4, slope_error
    # Measure the rendered triangle interpolation against every native cell.
    rr, cc = np.indices(shape)
    stride = manifest['render']['stride']
    r0, c0 = (rr // stride) * stride, (cc // stride) * stride
    r1, c1 = np.minimum(r0 + stride, rows - 1), np.minimum(c0 + stride, columns - 1)
    fy = np.divide(rr - r0, r1 - r0, out=np.zeros(shape), where=r1 != r0)
    fx = np.divide(cc - c0, c1 - c0, out=np.zeros(shape), where=c1 != c0)
    tl, tr, bl, br = a[r0, c0], a[r0, c1], a[r1, c0], a[r1, c1]
    predicted = np.where(fx + fy <= 1, tl + fx * (tr - tl) + fy * (bl - tl), br + (1 - fy) * (tr - br) + (1 - fx) * (bl - br))
    error = np.abs(predicted - a)
    max_error = float(np.max(error[coverage == 1]))
    assert max_error < 1.0, max_error
    spot_checks = [{'row': r, 'column': c, 'elevationM': float(z[r, c]), 'slopeDeg': float(slope[r, c]), 'sourceElevationDifferenceM': float(z[r, c] - original[r, c])} for r, c in [(100, 100), (375, 420), (480, 500), (503, 554), (800, 800)]]
    report = {
        'datasetVersion': manifest['datasetVersion'], 'status': 'passed',
        'nativeGrid': list(shape), 'validCells': int(coverage.sum()), 'unknownCells': int((coverage == 0).sum()),
        'reviewedExclusionCells': int(exclusions.sum()), 'slopeIndependentMaxErrorDeg': slope_error,
        'sourceElevationMaxErrorM': 0, 'opticalTextureMaxDnError': 0,
        'renderStride': stride, 'renderTriangleMaxVerticalDeviationM': max_error,
        'renderTriangleRmsVerticalDeviationM': float(np.sqrt(np.mean(error[coverage == 1] ** 2))),
        'spotChecks': spot_checks,
        'absoluteGeolocationAccuracyM': None,
        'scope': 'Source-grid equality, texture orientation/values, independent native slopes and display interpolation. Does not approve endpoint safety or certify absolute positioning.',
    }
    (ROOT / 'config/columbia-hills/terrain-validation.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    validate()
