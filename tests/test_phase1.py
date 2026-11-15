"""Independent acceptance checks against the acquired and exported Phase 1 files."""

import hashlib
import json
import unittest
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data/raw/columbia-hills'
WORK = ROOT / 'data/work/columbia-hills/phase1'
CONFIG = ROOT / 'config/columbia-hills'


class PhaseOneCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gdal.UseExceptions()
        cls.report = json.loads((CONFIG / 'coverage-review.json').read_text())
        cls.mission = json.loads((CONFIG / 'mission-review.json').read_text())

    def test_downloads_match_recorded_sizes_and_checksums(self):
        inventory = json.loads((CONFIG / 'sources.json').read_text())
        for record in [*inventory['products'], *inventory['references']]:
            path = RAW / record['filename']
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            self.assertEqual(path.stat().st_size, record['verifiedBytes'])
            self.assertEqual(digest.hexdigest(), record['sha256'])

    def test_label_georeferencing_matches_dtm_and_does_not_reuse_jp2_crs(self):
        dem = gdal.Open(str(RAW / 'DTEEC_001513_1655_001777_1650_U01.IMG'))
        label = gdal.Open(str(RAW / 'PSP_001513_1655_RED_C_01_ORTHO.LBL'))
        native = gdal.Open(str(RAW / 'PSP_001513_1655_RED_C_01_ORTHO.JP2'))
        self.assertEqual(dem.GetGeoTransform(), label.GetGeoTransform())
        self.assertTrue(dem.GetSpatialRef().IsSame(label.GetSpatialRef()))
        self.assertFalse(dem.GetSpatialRef().IsSame(native.GetSpatialRef()))
        np.testing.assert_array_equal(label.ReadAsArray(4800, 6400, 40, 40), native.ReadAsArray(4800, 6400, 40, 40))

    def test_mission_crop_has_matching_grid_and_valid_measured_terrain(self):
        dem = gdal.Open(str(WORK / 'elevation-review.tif'))
        optical = gdal.Open(str(WORK / 'optical-review.tif'))
        self.assertEqual(dem.GetGeoTransform(), optical.GetGeoTransform())
        heights = dem.ReadAsArray()
        valid = np.isfinite(heights) & (heights != dem.GetRasterBand(1).GetNoDataValue()) & (optical.ReadAsArray() != 0)
        self.assertEqual(int(valid.sum()), self.report['crop']['sharedValidCells'])
        self.assertTrue(valid.all())
        self.assertTrue(np.all((heights > -2000) & (heights < -1800)))
        self.assertAlmostEqual(dem.RasterXSize * dem.GetGeoTransform()[1], self.report['crop']['sizeM'][0])

    def test_vector_footprint_preserves_native_valid_cell_area(self):
        data = ogr.Open(str(WORK / 'coverage-review.gpkg'))
        layer = data.GetLayerByName('shared_coverage')
        area = sum(feature.GetGeometryRef().GetArea() for feature in layer)
        cell_area = self.report['transform'][1] * abs(self.report['transform'][5])
        self.assertAlmostEqual(area / cell_area, self.report['sharedValidSourceCells'], delta=0.01)

    def test_registered_marker_remains_near_home_plate_and_inside_review_crop(self):
        geo = {item['id']: item for item in self.mission['features']}
        science = geo['science-uncertainty']['center']
        home_points = np.array(geo['home-plate']['geometry']['coordinates'][0][:-1])
        self.assertGreater(science[0], home_points[:, 0].mean())
        self.assertLess(np.linalg.norm(science - home_points.mean(0)), 100)
        west, south, east, north = self.report['crop']['boundsWSEN']
        for item in geo.values():
            geometry = item['geometry']
            points = [geometry['coordinates']] if geometry['type'] == 'Point' else geometry['coordinates'][0]
            for x, y in points:
                self.assertTrue(west <= x <= east and south <= y <= north)
        self.assertIsNone(self.mission['approvedStagingPoint'])
        self.assertIsNone(self.mission['approvedScienceApproach'])

    def test_image_registration_passes_held_out_control_checks(self):
        registration = self.report['registration']
        source = np.array([[*point['figurePixel'], 1] for point in registration['controls']])
        target = np.array([point['rasterPixel'] for point in registration['controls']])
        for index in range(len(source)):
            keep = np.arange(len(source)) != index
            fit = np.linalg.lstsq(source[keep], target[keep], rcond=None)[0]
            residual_m = np.linalg.norm(source[index] @ fit - target[index]) * self.report['transform'][1]
            self.assertLess(residual_m, 2.0)
        self.assertIsNone(self.report['absoluteGeolocationAccuracyM'])
        self.assertEqual(self.mission['scienceEvidence']['observation'], 'PIA11758')


if __name__ == '__main__':
    unittest.main()
