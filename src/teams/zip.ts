// A zip file of stored (uncompressed) text entries: enough for an export that opens in any unzip tool.

import { crc32 } from 'node:zlib'

type Field = readonly [at: number, size: number, value: number]
const fill = (b: Buffer, fields: Field[]) => fields.forEach(([at, size, v]) => b.writeUIntLE(v, at, size))

/** Undefined past 65,535 files, the most a plain (non-ZIP64) zip can count. */
export function zip(files: [string, string][], at = new Date()): Buffer | undefined {
  if (files.length > 0xffff) return undefined
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  const body: Buffer[] = []
  const dir: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const n = Buffer.from(name)
    const d = Buffer.from(text)
    const sums: Field[] = [[14, 4, crc32(d)], [18, 4, d.length], [22, 4, d.length]]
    const h = Buffer.alloc(30)
    // Signature, version, flags (UTF-8 names), time, date, then the checksum and sizes (method 0 = stored).
    fill(h, [[0, 4, 0x04034b50], [4, 2, 20], [6, 2, 0x800], [10, 2, time], [12, 2, date], [26, 2, n.length], ...sums])
    const c = Buffer.alloc(46)
    fill(c, [[0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [8, 2, 0x800], [12, 2, time], [14, 2, date], [28, 2, n.length], [42, 4, offset], [16, 4, crc32(d)], [20, 4, d.length], [24, 4, d.length]])
    body.push(h, n, d)
    dir.push(c, n)
    offset += h.length + n.length + d.length
  }
  const end = Buffer.alloc(22)
  fill(end, [[0, 4, 0x06054b50], [8, 2, files.length], [10, 2, files.length], [12, 4, dir.reduce((s, b) => s + b.length, 0)], [16, 4, offset]])

  return Buffer.concat([...body, ...dir, end])
}
