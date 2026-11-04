// Renders the README plates from their SVG sources: assets/readme/src/<name>.svg -> assets/readme/<name>.png.
// Usage: npm run readme:art [-- <name> ...]   (no names: every plate)
// A source can pull in shared pieces with <!--#inline shared/<file>.svg--> (the inner markup of that file's root <svg>)
// A raster piece is written <image href="shared/<file>.png"> and embedded as a data URL.
// Fonts come only from src/shared/fonts, never the system, so a render is the same on every machine.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'assets/readme/src')
const OUT = join(ROOT, 'assets/readme')
const FONTS = readdirSync(join(SRC, 'shared/fonts')).filter((f) => f.endsWith('.ttf')).map((f) => join(SRC, 'shared/fonts', f))

const inner = (file) => {
  const svg = readFileSync(join(SRC, file), 'utf8')
  return svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
}

function build(name) {
  const svg = readFileSync(join(SRC, `${name}.svg`), 'utf8')
    .replace(/<!--#inline ([\w./-]+)-->/g, (_, f) => inner(f))
    .replace(/href="(shared\/[\w.-]+\.png)"/g, (_, f) => `href="data:image/png;base64,${readFileSync(join(SRC, f)).toString('base64')}"`)
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 2560 }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'EB Garamond' } }).render().asPng()
  writeFileSync(join(OUT, `${name}.png`), png)
  console.log(`${name}.png ${Math.round(png.length / 1024)} KB`)
}

const all = readdirSync(SRC).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4))
const asked = process.argv.slice(2)
for (const name of asked.length ? asked : all) {
  if (!all.includes(name)) throw new Error(`no source assets/readme/src/${name}.svg`)
  build(name)
}
