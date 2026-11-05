import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// Apple requires the default store icon to have no alpha channel, even when
// every alpha value is opaque. Encode Resvg's rendered RGBA pixels as RGB PNG.
function rgbPng(rendered) {
  const { width, height, pixels } = rendered;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 4;
    if (pixels[from + 3] !== 255) throw new Error('The app icon must be fully opaque.');
    pixels.copy(rows, y * (1 + width * 3) + 1 + x * 3, from, from + 3);
  }
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); type.copy(out, 4); data.copy(out, 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const svg = await readFile(path.join(root, 'dist/icon.svg'), 'utf8');
for (const [size, target] of [
  [180, 'dist/apple-touch-icon.png'], [192, 'dist/icon-192.png'], [512, 'dist/icon-512.png'],
  [1024, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'],
]) {
  await mkdir(path.dirname(path.join(root, target)), { recursive: true });
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: '#163f35' }).render();
  const png = size === 1024 ? rgbPng(rendered) : rendered.asPng();
  await writeFile(path.join(root, target), png);
}
const splash = `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="#f8f7f2"/><svg x="1222" y="1222" width="288" height="288" viewBox="0 0 192 192">${svg.replace(/^.*?<svg[^>]*>/s, '').replace(/<\/svg>\s*$/, '')}</svg></svg>`;
const splashPng = new Resvg(splash, { background: '#f8f7f2' }).render().asPng();
for (const filename of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
  await writeFile(path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset', filename), splashPng);
console.log('Iqri app, home-screen and launch icons generated.');
