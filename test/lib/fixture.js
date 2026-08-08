// Test fixtures generated on demand rather than committed or assumed to exist.
// framh.js used to read '/tmp/frame_test.jpg', a file that is not in the repo — so photo-framing
// tests failed on a clean checkout with an ENOENT that looked like a code bug.
const fs = require('fs'), path = require('path');
const { outDir } = require('./out');

/**
 * A 4-quadrant JPEG (red / green / blue / yellow). The quadrants are the point: after a crop or a
 * rotate you can sample the rendered tile and know exactly which corner of the source landed there,
 * which is how the drinks photo-framing behaviour was originally verified.
 */
function frameTestJpeg(size = 256) {
  const file = path.join(outDir('fixtures'), `frame_test_${size}.jpg`);
  if (fs.existsSync(file)) return file;

  const half = size / 2;
  const rgb = Buffer.alloc(size * size * 3);
  const quad = [[220, 30, 30], [30, 170, 60], [40, 80, 200], [235, 200, 40]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = quad[(y < half ? 0 : 2) + (x < half ? 0 : 1)];
    const i = (y * size + x) * 3;
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
  }
  // encode via MuPDF, already a devDependency — avoids pulling in an image library just for this
  return import('mupdf').then(mupdf => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, size, size], false);
    const buf = pix.getPixels();
    for (let p = 0, s = 0; s < rgb.length; p += 3, s += 3) { buf[p] = rgb[s]; buf[p + 1] = rgb[s + 1]; buf[p + 2] = rgb[s + 2]; }
    fs.writeFileSync(file, pix.asJPEG(90));
    return file;
  });
}

module.exports = { frameTestJpeg };
