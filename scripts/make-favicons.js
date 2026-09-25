/**
 * Erzeugt aus public/favicon.svg die Dateien
 *   - public/favicon.ico          (PNG-Einträge 16, 32 und 48 px)
 *   - public/apple-touch-icon.png (180 px, ohne Eckenradius – iOS rundet selbst ab)
 *
 * Nutzung (vom Projektroot, nach einer Änderung an favicon.svg):
 *   node scripts/make-favicons.js
 *
 * Verwendet das ohnehin installierte sharp; keine zusätzlichen Abhängigkeiten.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SVG_FILE = path.join(PUBLIC_DIR, 'favicon.svg');
const ICO_FILE = path.join(PUBLIC_DIR, 'favicon.ico');
const TOUCH_FILE = path.join(PUBLIC_DIR, 'apple-touch-icon.png');
const ICO_SIZES = [16, 32, 48];
const TOUCH_SIZE = 180;

// SVG in hoher Auflösung rastern und dann verkleinern, damit kleine Größen scharf bleiben.
function render(svg, size) {
  return sharp(Buffer.from(svg), { density: Math.max(72, 72 * size / 16) })
    .resize(size, size)
    .png()
    .toBuffer();
}

// Apple-Icon: Hintergrund ohne Radius und etwas mehr Rand um das Motiv.
function touchVariant(svg) {
  const out = svg
    .replace('viewBox="0 0 64 64"', 'viewBox="-4 -4 72 72"')
    .replace(/<rect width="64" height="64" rx="[\d.]+"/, '<rect x="-4" y="-4" width="72" height="72"');
  if (out === svg) throw new Error('favicon.svg hat nicht den erwarteten Aufbau (viewBox 0 0 64 64, Hintergrund-Rechteck zuerst).');
  return out;
}

// ICO-Container mit PNG-Einträgen (von allen aktuellen Browsern und Windows unterstützt).
function buildIco(pngs, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserviert
  header.writeUInt16LE(1, 2);            // Typ 1 = Icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);           // Farbebenen
    entry.writeUInt16LE(32, 6);          // Bit pro Pixel
    entry.writeUInt32LE(pngs[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

async function main() {
  const svg = fs.readFileSync(SVG_FILE, 'utf8');
  const pngs = await Promise.all(ICO_SIZES.map(size => render(svg, size)));
  fs.writeFileSync(ICO_FILE, buildIco(pngs, ICO_SIZES));
  console.log(`✓ ${path.relative(process.cwd(), ICO_FILE)} (${ICO_SIZES.join('/')} px)`);
  fs.writeFileSync(TOUCH_FILE, await render(touchVariant(svg), TOUCH_SIZE));
  console.log(`✓ ${path.relative(process.cwd(), TOUCH_FILE)} (${TOUCH_SIZE} px)`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
