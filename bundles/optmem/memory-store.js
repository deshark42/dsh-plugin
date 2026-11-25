import { randomUUID } from 'node:crypto'
import { closeSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, parse, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const APPLICATION_ID = 0x4f50544d
const BUSY_TIMEOUT_MS = 1000
const GIT_METADATA_BYTES = 64 * 1024
const SUMMARY_BYTES = 240
const TRUNCATION_MARK = '…'
const SIDECARS = ['-journal', '-wal', '-shm']
const TEXT_LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const CREATE_ENTRIES = [
  'CREATE TABLE optmem_entries (',
  '  seq INTEGER PRIMARY KEY,',
  '  workspace TEXT NOT NULL,',
  '  id TEXT NOT NULL UNIQUE,',
  '  text TEXT NOT NULL,',
  '  created_at TEXT NOT NULL',
  ') STRICT',
].join('\n')
const CREATE_RECENT_INDEX = 'CREATE INDEX optmem_recent ON optmem_entries (workspace, created_at DESC, seq DESC)'

function checkString(value, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    throw new TypeError(`Invalid OptMem ${label}.`)
  }
}

function checkAbsolute(path, label) {
  checkString(path, label)
  if (!isAbsolute(path)) throw new TypeError(`OptMem ${label} must be an absolute path.`)
}

function checkWorkspaceKey(key) {
  checkString(key, 'workspace key')
  if (!['dir:', 'git:'].includes(key.slice(0, 4)) || !isAbsolute(key.slice(4))) {
    throw new TypeError('OptMem workspace key must identify an absolute Git or directory path.')
  }
}

async function canonicalPath(path) {
  return UTF8.decode(await realpath(path, { encoding: 'buffer' }))
}

async function hasGitEntry(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

function resolveGitPath(directory, path) {
  // Let realpath resolve '..' after symlinks rather than normalizing the pointer lexically.
  return canonicalPath(isAbsolute(path) ? path : `${directory}${directory.endsWith(sep) ? '' : sep}${path}`)
}

async function readGitMetadata(path) {
  if (!(await stat(path)).isFile()) throw new Error(`Not a regular Git metadata file: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > GIT_METADATA_BYTES) throw new Error(`Invalid Git metadata file: ${path}`)
    const buffer = Buffer.allocUnsafe(GIT_METADATA_BYTES + 1)
    let end = 0
    while (end < buffer.length) {
      const { bytesRead } = await file.read(buffer, end, buffer.length - end, end)
      if (bytesRead === 0) break
      end += bytesRead
    }
    if (end > GIT_METADATA_BYTES) throw new Error(`Git metadata file is too large: ${path}`)
    while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end--
    const line = UTF8.decode(buffer.subarray(0, end))
    if (!line || /[\r\n\0]/u.test(line)) throw new Error(`Invalid Git metadata line: ${path}`)
    return line
  } finally {
    await file.close()
  }
}

async function hasGitHead(path) {
  // An old-style symbolic HEAD can refer to an unborn branch; do not open its target.
  if ((await lstat(path)).isSymbolicLink()) return (await readlink(path)).startsWith('refs/')
  return /^(?:ref:[ \t]*refs\/[^\r\n\0]+|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(await readGitMetadata(path))
}

async function resolveGitCommonDir(root, dotGit) {
  let gitDir = await canonicalPath(dotGit)
  const info = await stat(gitDir)
  if (info.isFile()) {
    const gitfile = await readGitMetadata(gitDir)
    if (!gitfile.startsWith('gitdir: ') || gitfile.length === 8) throw new Error('Invalid gitdir pointer.')
    gitDir = await resolveGitPath(root, gitfile.slice(8))
  } else if (!info.isDirectory()) {
    throw new Error('Not a Git directory or gitfile.')
  }

  const commondir = join(gitDir, 'commondir')
  const common = await hasGitEntry(commondir) ? await resolveGitPath(gitDir, await readGitMetadata(commondir)) : gitDir
  const [head, objects, refs] = await Promise.all([
    hasGitHead(join(gitDir, 'HEAD')),
    stat(join(common, 'objects')),
    stat(join(common, 'refs')),
  ])
  if (!head || !objects.isDirectory() || !refs.isDirectory()) throw new Error('Invalid Git directory layout.')
  return common
}

export async function resolveWorkspace(cwd) {
  checkAbsolute(cwd, 'working directory')
  const absolute = await canonicalPath(cwd)
  if (!(await stat(absolute)).isDirectory()) throw new Error('OptMem working directory is not a directory.')
  for (let root = absolute; ; root = dirname(root)) {
    const dotGit = join(root, '.git')
    if (await hasGitEntry(dotGit)) {
      try {
        const gitCommonDir = await resolveGitCommonDir(root, dotGit)
        return { root, gitCommonDir, key: `git:${gitCommonDir}` }
      } catch (cause) {
        throw new Error(`Invalid OptMem Git metadata: ${dotGit}`, { cause })
      }
    }
    if (dirname(root) === root) return { root: absolute, gitCommonDir: null, key: `dir:${absolute}` }
  }
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function checkDirectory(path, create) {
  const root = parse(path).root
  let current = root
  let info = lstatSync(root)
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    info = lstatIfPresent(current)
    if (!info) {
      if (!create) return false
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      info = lstatSync(current)
    }
    if (!info.isDirectory()) throw new Error(`Not a regular OptMem database directory: ${current}`)
  }
  if (process.geteuid && (info.uid !== process.geteuid() || (info.mode & 0o022) !== 0)) {
    throw new Error(`OptMem database directory must be owner-controlled: ${path}`)
  }
  return true
}

function checkPrivateFile(info, path) {
  if (!info.isFile() || (process.geteuid && (info.uid !== process.geteuid() || (info.mode & 0o077) !== 0))) {
    throw new Error(`Not a private regular OptMem database file: ${path}`)
  }
}

function foreignDatabase(path) {
  return new Error(`Not an OptMem database: ${path}`)
}

function unsupportedSchema(path) {
  return new Error(`Unsupported OptMem database schema: ${path}`)
}

function checkDatabase(path) {
  const info = lstatIfPresent(path)
  if (!info) return false
  checkPrivateFile(info, path)
  if (info.size < 100) throw foreignDatabase(path)
  for (const suffix of SIDECARS) {
    const sidecar = lstatIfPresent(path + suffix)
    if (!sidecar) continue
    checkPrivateFile(sidecar, path + suffix)
    if (suffix !== '-journal' || sidecar.nlink !== 1) throw unsupportedSchema(path)
  }
  // Probe only fixed schema metadata without letting SQLite recover journals or create WAL files.
  // Use SQLite connections even here: a raw file open/close can drop this process's SQLite locks.
  withDatabase(path, 'ro', db => verifySchema(db, path), { immutable: true })
  return true
}

function withDatabase(path, mode, action, { immutable = false } = {}) {
  const address = pathToFileURL(path)
  address.searchParams.set('mode', mode)
  if (immutable) address.searchParams.set('immutable', '1')
  const db = new DatabaseSync(address, { readOnly: mode === 'ro', allowExtension: false })
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY`)
    return action(db)
  } finally {
    db.close()
  }
}

function transaction(db, begin, action) {
  db.exec(begin)
  const result = action()
  db.exec('COMMIT')
  return result
}

function initializeDatabase(path) {
  if (SIDECARS.some(suffix => lstatIfPresent(path + suffix)) && !lstatIfPresent(path)) {
    throw new Error(`Orphaned SQLite sidecar at the OptMem database path: ${path}`)
  }
  const staging = mkdtempSync(join(dirname(path), '.optmem-init-'))
  try {
    const staged = join(staging, basename(path))
    closeSync(openSync(staged, 'wx', 0o600))
    withDatabase(staged, 'rw', db => transaction(db, 'BEGIN IMMEDIATE', () => {
      db.exec(CREATE_ENTRIES)
      db.exec(CREATE_RECENT_INDEX)
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    }))
    // Publish only a complete database, without claiming an existing file (even an empty one).
    try {
      linkSync(staged, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function verifySchema(db, path) {
  if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw foreignDatabase(path)
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw unsupportedSchema(path)
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name').all()
  if (schema.length !== 2 || schema[0].sql !== CREATE_ENTRIES || schema[1].sql !== CREATE_RECENT_INDEX) {
    throw unsupportedSchema(path)
  }
}

function summarize(text) {
  const bytes = Buffer.from(text)
  if (bytes.length <= SUMMARY_BYTES) return { summary: text, truncated: false }
  let end = SUMMARY_BYTES - Buffer.byteLength(TRUNCATION_MARK)
  while ((bytes[end] & 0xc0) === 0x80) end--
  return { summary: bytes.toString('utf8', 0, end) + TRUNCATION_MARK, truncated: true }
}

export function createMemoryStore(databasePath) {
  checkAbsolute(databasePath, 'database path')
  if (normalize(databasePath) !== databasePath || !basename(databasePath) || databasePath.endsWith(sep)) {
    throw new TypeError('OptMem database path must be a normalized absolute file path.')
  }
  const directory = dirname(databasePath)
  function withVerifiedDatabase(mode, action) {
    const begin = mode === 'rw' ? 'BEGIN IMMEDIATE' : 'BEGIN'
    return withDatabase(databasePath, mode, db => transaction(db, begin, () => {
      verifySchema(db, databasePath)
      return action(db)
    }))
  }

  function read(empty, action) {
    if (!checkDirectory(directory, false) || !checkDatabase(databasePath)) return empty
    return withVerifiedDatabase('ro', action)
  }

  return {
    search(workspace, query, limit) {
      checkWorkspaceKey(workspace)
      checkString(query, 'search query')
      if (Buffer.byteLength(query) > 256) throw new RangeError('OptMem search query exceeds 256 UTF-8 bytes.')
      if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid OptMem search limit.')
      const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
      return read({ matches: [], hasMore: false }, db => {
        db.function('optmem_contains', { deterministic: true, directOnly: true }, text => Number(literal.test(text)))
        const rows = db.prepare([
          'SELECT id, text, created_at AS createdAt FROM optmem_entries',
          'WHERE workspace = ? AND optmem_contains(text)',
          'ORDER BY created_at DESC, seq DESC LIMIT ?',
        ].join(' ')).all(workspace, BigInt(limit) + 1n)
        return {
          matches: rows.slice(0, limit).map(({ id, text, createdAt }) => ({ id, ...summarize(text), createdAt })),
          hasMore: rows.length > limit,
        }
      })
    },

    get(workspace, id) {
      checkWorkspaceKey(workspace)
      checkString(id, 'record ID')
      return read(null, db => {
        const row = db.prepare([
          'SELECT id, text, created_at AS createdAt FROM optmem_entries WHERE workspace = ? AND id = ?',
        ].join(' ')).get(workspace, id)
        return row ? { ...row } : null
      })
    },

    save(workspace, text) {
      checkWorkspaceKey(workspace)
      checkString(text, 'record text')
      if (!text.trim() || TEXT_LINE_BREAK.test(text)) throw new TypeError('OptMem record must be a non-empty single line.')
      if (Buffer.byteLength(text) > 1200) throw new RangeError('OptMem record exceeds 1200 UTF-8 bytes.')
      checkDirectory(directory, true)
      if (!lstatIfPresent(databasePath)) initializeDatabase(databasePath)
      if (!checkDatabase(databasePath)) throw new Error(`OptMem database disappeared: ${databasePath}`)
      return withVerifiedDatabase('rw', db => {
        const id = randomUUID()
        const createdAt = new Date().toISOString()
        db.prepare('INSERT INTO optmem_entries (workspace, id, text, created_at) VALUES (?, ?, ?, ?)')
          .run(workspace, id, text, createdAt)
        return { id, text, createdAt }
      })
    },
  }
}
