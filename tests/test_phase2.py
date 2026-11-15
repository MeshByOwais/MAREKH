import json
import unittest
from pathlib import Path

import numpy as np
from osgeo import gdal

ROOT = Path(__file__).resolve().parents[1]


def slope_of(values):
    gdal.UseExceptions()
    dem = gdal.GetDriverByName('MEM').Create('', values.shape[1], values.shape[0], 1, gdal.GDT_Float32)
    dem.SetGeoTransform([0, 5, 0, 0, 0, -5])
    dem.GetRasterBand(1).SetNoDataValue(-9999)
    dem.GetRasterBand(1).WriteArray(values.astype('f4'))
    result = gdal.DEMProcessing('', dem, 'slope', format='MEM', alg='Horn', scale=1, computeEdges=False)
    return result.ReadAsArray(), result.GetRasterBand(1).GetNoDataValue()


class PhaseTwoTerrain(unittest.TestCase):
    def test_flat_ground_has_zero_slope_and_unknown_border(self):
        slope, nodata = slope_of(np.full((11, 13), 100))
        np.testing.assert_array_equal(slope[1:-1, 1:-1], 0)
        self.assertTrue((slope[0] == nodata).all())
        self.assertTrue((slope[:, -1] == nodata).all())

    def test_two_axis_analytic_plane_has_expected_slope(self):
        row, column = np.indices((11, 13))
        values = 100 + column * 2.5 + row * 1.25
        slope, _ = slope_of(values)
        expected = np.degrees(np.arctan(np.hypot(0.5, 0.25)))
        np.testing.assert_allclose(slope[1:-1, 1:-1], expected, atol=1e-4, rtol=0)

    def test_missing_pixel_invalidates_neighbourhood_without_filling(self):
        values = np.full((11, 13), 100.0)
        values[5, 6] = -9999
        slope, nodata = slope_of(values)
        self.assertTrue((slope[4:7, 5:8] == nodata).all())
        self.assertEqual(slope[2, 2], 0)

    def test_real_package_preserves_source_and_covers_required_assets(self):
        package = ROOT / 'public/sites/columbia-hills/terrain-v1'
        manifest = json.loads((package / 'manifest.json').read_text())
        for required in ['elevation.f32', 'slope-deg.f32', 'coverage.u8', 'exclusions.u8', 'texture.webp', 'mission.json']:
            self.assertIn(required, manifest['assets'])
        self.assertEqual(manifest['texture']['boundsWSEN'], manifest['boundsWSEN'])
        self.assertEqual(manifest['render']['verticalScale'], 1)
        report = json.loads((ROOT / 'config/columbia-hills/terrain-validation.json').read_text())
        self.assertEqual(report['sourceElevationMaxErrorM'], 0)
        self.assertEqual(report['opticalTextureMaxDnError'], 0)
        self.assertLess(report['slopeIndependentMaxErrorDeg'], 1e-4)
        self.assertLess(report['renderTriangleMaxVerticalDeviationM'], 1)

    def test_manual_exclusions_have_reasons_and_mission_is_unapproved(self):
        package = ROOT / 'public/sites/columbia-hills/terrain-v1'
        exclusions = json.loads((package / 'exclusions.json').read_text())
        self.assertEqual(len(exclusions['features']), 2)
        self.assertTrue(all(feature['reason'] and feature['sourceProduct'] for feature in exclusions['features']))
        mask = np.fromfile(package / 'exclusions.u8', dtype='u1').reshape((990, 990))
        self.assertEqual(mask[490, 150], 1)
        self.assertEqual(mask[330, 800], 1)
        self.assertEqual(mask[480, 500], 0)
        mission = json.loads((package / 'mission.json').read_text())
        self.assertIsNone(mission['approvedScienceApproach'])
        self.assertIsNone(mission['approvedStagingPoint'])


if __name__ == '__main__':
    unittest.main()
