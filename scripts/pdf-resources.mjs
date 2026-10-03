import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../node_modules/pdfjs-dist/', import.meta.url);

/** Same offline binary resources in the release and browser acceptance bundle. */
export function readPdfResources() {
  const resources = {};
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const filename of readdirSync(new URL(`${directory}/`, root))) {
      if (/\.(bcmap|pfb|ttf|wasm)$/.test(filename)) {
        resources[`${directory}/${filename}`] = readFileSync(new URL(`${directory}/${filename}`, root)).toString('base64');
      }
    }
  }
  return resources;
}

export function readPdfResourceLicenses() {
  return ['standard_fonts', 'wasm'].flatMap(directory =>
    readdirSync(new URL(`${directory}/`, root)).filter(name => name.startsWith('LICENSE'))
      .map(name => `${directory}/${name}:\n${readFileSync(new URL(`${directory}/${name}`, root), 'utf8')}`)
  ).join('\n');
}
