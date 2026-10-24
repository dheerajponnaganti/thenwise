// The IO port: core never touches the file system, processes or the network itself.
// Hosts pass this in (a host app maps it to its own API, Node to node:fs).

export interface DirEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
}

export interface IO {
  /** null when the file is missing or cannot be read (for example a cloud placeholder). */
  readText(path: string): Promise<string | null>
  /** Must not leave a half-written file behind where the platform allows (temp file and rename). */
  writeText(path: string, text: string): Promise<void>
  list(dir: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  now(): number
  /** Runs a program (git, for staleness). Optional: hosts without processes leave it out and staleness is skipped. */
  run?(argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string }>
}
