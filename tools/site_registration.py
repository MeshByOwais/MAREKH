"""Small image-registration helpers for the published Home Plate context map."""

import numpy as np
from PIL import Image


def correlate(image, rgb, shape):
    """Masked normalized correlation, rejecting colored annotations and black arrows."""
    height, width = rgb.shape[:2]
    template = rgb.mean(2)
    mask = ((rgb.max(2) - rgb.min(2) < 18) & (template > 30)).astype(float)
    count = mask.sum()
    if count < 9:
        raise ValueError('Too few unannotated reference pixels')
    template = (template - (template * mask).sum() / count) * mask
    spectrum = np.fft.rfft2(image, shape)
    mask_spectrum = np.fft.rfft2(mask[::-1, ::-1], shape)
    region = (slice(height - 1, image.shape[0]), slice(width - 1, image.shape[1]))
    numerator = np.fft.irfft2(spectrum * np.fft.rfft2(template[::-1, ::-1], shape), shape)[region]
    sums = np.fft.irfft2(spectrum * mask_spectrum, shape)[region]
    squares = np.fft.irfft2(np.fft.rfft2(image * image, shape) * mask_spectrum, shape)[region]
    denominator = np.sqrt(np.maximum(squares - sums * sums / count, 0) * (template * template).sum())
    scores = np.divide(numerator, denominator, out=np.full_like(numerator, -1), where=denominator > 1)
    row, column = np.unravel_index(np.argmax(scores), scores.shape)
    return float(scores[row, column]), int(column), int(row)


def register_figure(dataset, figure):
    """Register Figure 1's unannotated plateau to the label-georeferenced raster.

    A bounded search around the independently located NASA reference match is
    refined with six local patches. Raster positions use zero-based pixel centres.
    The residual describes relative image fit, not absolute Mars positioning.
    """
    image = dataset.ReadAsArray(4730, 6290, 370, 400).astype(float)
    patch = figure.crop((210, 35, 505, 289))
    candidates = []
    for scale in np.arange(0.32, 0.431, 0.002):
        width, height = round(patch.width * scale), round(patch.height * scale)
        rgb = np.asarray(patch.resize((width, height), Image.Resampling.LANCZOS)).astype(float)
        score, x, y = correlate(image, rgb, (1024, 512))
        candidates.append((score, x + 4730, y + 6290, width / patch.width, height / patch.height))
    score, x, y, sx, sy = max(candidates)
    if score < 0.7:
        raise ValueError(f'Published map registration did not meet correlation gate: {score}')
    origin = [x - 210 * sx, y - 35 * sy]
    controls = []
    for fx, fy in [(282, 76), (441, 97), (414, 242), (272, 235), (343, 66), (474, 153)]:
        radius = 25
        reference = figure.crop((fx - radius, fy - radius, fx + radius + 1, fy + radius + 1))
        size = (round(reference.width * sx), round(reference.height * sy))
        template = np.asarray(reference.resize(size, Image.Resampling.LANCZOS)).astype(float)
        predicted = np.array(origin) + [fx * sx, fy * sy]
        left, top = np.floor(predicted - np.array(size) / 2 - 6).astype(int)
        window = dataset.ReadAsArray(int(left), int(top), size[0] + 13, size[1] + 13).astype(float)
        local_score, dx, dy = correlate(window, template, (64, 64))
        observed = [left + dx + (size[0] - 1) / 2, top + dy + (size[1] - 1) / 2]
        controls.append({'figurePixel': [fx, fy], 'rasterPixel': list(map(float, observed)), 'correlation': local_score})
    source = np.array([[*c['figurePixel'], 1] for c in controls])
    target = np.array([c['rasterPixel'] for c in controls])
    matrix = np.linalg.lstsq(source, target, rcond=None)[0]
    residual = np.linalg.norm(source @ matrix - target, axis=1)
    held_out = []
    for index in range(len(source)):
        keep = np.arange(len(source)) != index
        fit = np.linalg.lstsq(source[keep], target[keep], rcond=None)[0]
        held_out.append(float(np.linalg.norm(source[index] @ fit - target[index])))
    if max(held_out) > 5 or min(c['correlation'] for c in controls) < 0.5:
        raise ValueError('Registration control patches failed the independent residual gate')
    return {
        'source': 'Ruff et al. (2008), LPSC abstract 2213, Figure 1',
        'sourceImageSize': [figure.width, figure.height],
        'globalCorrelation': score,
        'method': 'masked normalized cross-correlation, then affine least squares on six local patches',
        'pixelConvention': 'zero-based centres',
        'figureToRasterAffine': matrix.tolist(),
        'controls': controls,
        'fitResidualPixels': residual.tolist(),
        'leaveOneOutResidualPixels': held_out,
        'fitRmsPixels': float(np.sqrt(np.mean(residual ** 2))),
        'leaveOneOutMaxPixels': max(held_out),
        'absoluteGeolocationAccuracyM': None,
    }
