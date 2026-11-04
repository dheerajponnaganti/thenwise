// Renders a README recording from a tool's real output: assets/readme/src/tapes/<name>.json -> assets/readme/<name>.gif.
// Usage: npm run readme:gif -- <name>
// The spec holds the text the tool printed (captured from its own run, never written by hand) and the window title. The
// window is the plates' window; the prompt types, each tool call appears, the answer comes in line by line, the end holds.
// A spec with `lines` (each { text, color }) is a still instead: one PNG, as tall as its lines, at assets/readme/<name>.png.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'assets/readme/src')
const FONTS = readdirSync(join(SRC, 'shared/fonts')).filter((f) => f.endsWith('.ttf')).map((f) => join(SRC, 'shared/fonts', f))
const W = 1600, FPS = 12, SIZE = 25, LINE = 36, COLS = 84
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Words wrapped to COLS columns; a line keeps its own indent. */
function wrap(text, cols = COLS) {
  const out = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const w of para.split(' ')) {
      if (line && (line + ' ' + w).length > cols) (out.push(line), (line = w))
      else line = line ? `${line} ${w}` : w
    }
    out.push(line)
  }
  return out
}

/** One frame: the window with `rows` (already wrapped, each { text, color, dot }) and an optional typing cursor. */
function frame(title, rows, cursor, H = 980, caption = 'real output · ' + title) {
  const top = 150, left = 110
  const first = Math.max(0, rows.length - Math.floor((H - top - 110) / LINE)) // scroll once the window is full
  const body = rows.slice(first).map((r, i) => {
    const y = top + 70 + i * LINE
    const dot = r.dot ? `<circle cx="${left + 44}" cy="${y - 9}" r="7" fill="#E58A6E"/>` : ''
    return `${dot}<text x="${left + (r.dot ? 64 : 40) + (r.indent ?? 0) * SIZE * 0.6}" y="${y}" class="mono" font-size="${SIZE}" fill="${r.color}" xml:space="preserve">${esc(r.text)}${cursor && i === rows.length - first - 1 ? '█' : ''}</text>`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${readFileSync(join(SRC, 'shared/defs.svg'), 'utf8').replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')}
<rect width="${W}" height="${H}" fill="#E6DCC5"/>
<rect x="${left + 6}" y="${top - 52}" width="${W - 2 * left}" height="${H - top + 2}" rx="12" fill="#241C15" opacity="0.18"/>
<rect x="${left}" y="${top - 60}" width="${W - 2 * left}" height="${H - top + 2}" rx="12" fill="#1E1A16" stroke="#241C15" stroke-width="3"/>
<path d="M${left + 1.5} ${top - 48} a10.5 10.5 0 0 1 10.5 -10.5 H${W - left - 12} a10.5 10.5 0 0 1 10.5 10.5 V${top - 14} H${left + 1.5} Z" fill="#F4ECDA"/>
<g fill="none" stroke="#5E4E3E" stroke-width="2.2"><circle cx="${left + 30}" cy="${top - 36}" r="8"/><circle cx="${left + 54}" cy="${top - 36}" r="8"/><circle cx="${left + 78}" cy="${top - 36}" r="8"/></g>
<text x="${left + 104}" y="${top - 27}" class="mono" font-size="24" fill="#5E4E3E">${esc(title)}</text>
<text x="${W / 2}" y="${H - 18}" class="sc" font-size="20" fill="#5E4E3E" text-anchor="middle">${esc(caption)}</text>
${body}
</svg>`
}

function still(name, spec) {
  // `hang` indents a line's wrapped rows by that many columns, so a label's text lines up under itself.
  const rows = spec.lines.flatMap((l) => wrap(l.text, COLS - (l.hang ?? 0)).map((t, i) => ({ text: t, color: l.color ?? '#F1E9D6', indent: i ? l.hang : 0 })))
  const svg = frame(spec.title, rows, false, 150 + 110 + rows.length * LINE, spec.caption)
  const out = join(ROOT, 'assets/readme', `${name}.png`)
  writeFileSync(out, new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' } }).render().asPng())
  console.log(`${name}.png ${rows.length} rows, ${Math.round(readFileSync(out).length / 1024)} KB`)
}

function build(name) {
  const spec = JSON.parse(readFileSync(join(SRC, 'tapes', `${name}.json`), 'utf8'))
  if (spec.lines) return still(name, spec)
  const dir = mkdtempSync(join(tmpdir(), `readme-gif-${name}-`))
  const frames = []
  const rows = []
  const add = (svg, n = 1) => { for (let i = 0; i < n; i++) frames.push(svg) }
  const prompt = `› ${spec.prompt}`
  for (let i = 2; i <= prompt.length; i += 3) add(frame(spec.title, [...rows, ...wrap(prompt.slice(0, i)).map((t) => ({ text: t, color: '#F1E9D6' }))], true))
  rows.push(...wrap(prompt).map((t) => ({ text: t, color: '#F1E9D6' })), { text: '', color: '#F1E9D6' })
  add(frame(spec.title, rows), FPS / 2)
  for (const t of spec.tools) (rows.push({ text: t, color: '#C9BBA0', dot: true }), add(frame(spec.title, rows), FPS / 2))
  rows.push({ text: '', color: '#F1E9D6' })
  for (const para of spec.answer) {
    for (const t of wrap(para.text)) (rows.push({ text: t, color: para.color ?? '#F1E9D6' }), add(frame(spec.title, rows), 2))
    rows.push({ text: '', color: '#F1E9D6' })
  }
  add(frame(spec.title, rows), FPS * 4)
  // identical frames are written once and listed again, so gifski holds them
  let last = '', n = 0
  frames.forEach((svg, i) => {
    if (svg !== last) writeFileSync(join(dir, `f${String(++n).padStart(5, '0')}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' } }).render().asPng())
    else writeFileSync(join(dir, `f${String(++n).padStart(5, '0')}.png`), readFileSync(join(dir, `f${String(n - 1).padStart(5, '0')}.png`)))
    last = svg
  })
  const out = join(ROOT, 'assets/readme', `${name}.gif`)
  execFileSync('gifski', ['--fps', String(FPS), '--width', String(W), '--quality', '80', '-o', out, ...readdirSync(dir).sort().map((f) => join(dir, f))], { stdio: 'ignore' })
  rmSync(dir, { recursive: true, force: true })
  console.log(`${name}.gif ${frames.length} frames, ${Math.round(readFileSync(out).length / 1024)} KB`)
}

for (const name of process.argv.slice(2)) build(name)
