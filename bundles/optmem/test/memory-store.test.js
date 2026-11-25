import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

import { createMemoryStore, resolveWorkspace } from '../memory-store.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const emptySearch = { matches: [], hasMore: false }
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' })

async function fixture(t) {
  const base = join(await realpath(homedir()), 'tmp', 'dsh-plugin', 'optmem-sqlite')
  await mkdir(base, { recursive: true, mode: 0o700 })
  assert.equal(await realpath(base), base)
  const root = await mkdtemp(join(base, 'store-'))
  assert.equal(dirname(root), base)
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  const workspaceKey = `dir:${workspaceRoot}`
  const directory = join(root, 'new-store')
  const database = join(directory, 'notes # 100% ?.sqlite')
  return { root, directory, workspaceRoot, workspaceKey, database, store: createMemoryStore(database) }
}

async function makeGitDir(path) {
  await mkdir(join(path, 'refs', 'heads'), { recursive: true })
  await mkdir(join(path, 'objects'))
  await writeFile(join(path, 'HEAD'), 'ref: refs/heads/main\n')
  return path
}

async function makeWorktree(root, gitDir, gitfilePointer, commonPointer, head) {
  const dotGit = join(root, '.git')
  await mkdir(root, { recursive: true })
  await mkdir(gitDir, { recursive: true })
  await writeFile(dotGit, `gitdir: ${gitfilePointer}\n`)
  await writeFile(join(gitDir, 'HEAD'), `${head}\n`)
  await writeFile(join(gitDir, 'commondir'), `${commonPointer}\n`)
  await writeFile(join(gitDir, 'gitdir'), `${dotGit}\n`)
}

test('linked worktrees share their canonical Git common directory while retaining checkout roots', async t => {
  const { root, workspaceRoot, store } = await fixture(t)
  const nested = join(workspaceRoot, 'src', 'lib')
  await mkdir(nested, { recursive: true })
  const gitCommonDir = await makeGitDir(join(workspaceRoot, '.git'))
  const cwdAlias = join(root, 'checkout alias')
  const commonAlias = join(root, 'common metadata alias')
  await symlink(nested, cwdAlias, 'dir')
  await symlink(gitCommonDir, commonAlias, 'dir')

  const linkedRoot = join(root, 'linked worktree')
  const linkedGitDir = join(gitCommonDir, 'worktrees', 'absolute')
  await makeWorktree(linkedRoot, linkedGitDir, linkedGitDir, commonAlias, 'ref: refs/heads/topic')

  const relativeRoot = join(workspaceRoot, 'relative worktree')
  const relativeGitDir = join(gitCommonDir, 'worktrees', 'relative')
  const privateAlias = join(root, 'private metadata alias')
  await makeWorktree(relativeRoot, relativeGitDir, relative(relativeRoot, privateAlias), '../..', 'a'.repeat(40))
  await symlink(relativeGitDir, privateAlias, 'dir')

  const key = `git:${gitCommonDir}`
  const main = await resolveWorkspace(cwdAlias)
  const linked = await resolveWorkspace(linkedRoot)
  const relativeTree = await resolveWorkspace(relativeRoot)
  assert.deepEqual(main, { root: workspaceRoot, gitCommonDir, key })
  assert.deepEqual(await resolveWorkspace(nested), main)
  assert.deepEqual(linked, { root: linkedRoot, gitCommonDir, key })
  assert.deepEqual(relativeTree, { root: relativeRoot, gitCommonDir, key })

  const first = store.save(main.key, 'saved in the main checkout')
  const second = store.save(linked.key, 'saved in a linked worktree')
  assert.deepEqual(store.get(linked.key, first.id), first)
  assert.deepEqual(store.get(main.key, second.id), second)
  assert.deepEqual(store.search(relativeTree.key, '', 8).matches.map(row => row.id), [second.id, first.id])
})

test('nested repositories, submodules, independent clones and non-Git directories have separate keys', async t => {
  const { root, workspaceRoot, store } = await fixture(t)
  const parentGitDir = await makeGitDir(join(workspaceRoot, '.git'))
  const nestedRoot = join(workspaceRoot, 'nested')
  const nestedGitDir = await makeGitDir(join(nestedRoot, '.git'))
  const cloneRoot = join(root, 'independent clone')
  const cloneGitDir = await makeGitDir(join(cloneRoot, '.git'))
  const submoduleRoot = join(workspaceRoot, 'submodule')
  const submoduleGitDir = await makeGitDir(join(parentGitDir, 'modules', 'module metadata '))
  await mkdir(submoduleRoot)
  await writeFile(join(submoduleRoot, '.git'), `gitdir: ${relative(submoduleRoot, submoduleGitDir)}\r\n`)
  const outside = join(root, 'plain')
  const outsideChild = join(outside, 'src')
  await mkdir(outsideChild, { recursive: true })
  const outsideAlias = join(root, 'plain directory alias')
  await symlink(outsideChild, outsideAlias, 'dir')

  const parent = await resolveWorkspace(workspaceRoot)
  const saved = store.save(parent.key, 'only in the parent repo')
  const expected = [
    { root: nestedRoot, gitCommonDir: nestedGitDir, key: `git:${nestedGitDir}` },
    { root: cloneRoot, gitCommonDir: cloneGitDir, key: `git:${cloneGitDir}` },
    { root: submoduleRoot, gitCommonDir: submoduleGitDir, key: `git:${submoduleGitDir}` },
    { root: outside, gitCommonDir: null, key: `dir:${outside}` },
    { root: outsideChild, gitCommonDir: null, key: `dir:${outsideChild}` },
  ]
  const keys = new Set([parent.key])
  for (const workspace of expected) {
    const resolved = await resolveWorkspace(workspace.root)
    assert.deepEqual(resolved, workspace)
    assert.equal(store.get(resolved.key, saved.id), null)
    assert.deepEqual(store.search(resolved.key, '', 8), emptySearch)
    keys.add(resolved.key)
  }
  assert.deepEqual(await resolveWorkspace(outsideAlias), expected.at(-1))
  assert.equal(keys.size, expected.length + 1)
})

test('existing invalid Git metadata never aliases a directory or falls back to the enclosing repository', async t => {
  const { root, workspaceRoot } = await fixture(t)
  const gitDir = await makeGitDir(join(workspaceRoot, '.git'))
  const notGit = join(root, 'not a repository')
  const missing = join(root, 'missing metadata')
  await mkdir(notGit)
  const writeCommon = async (dotGit, write) => {
    await makeGitDir(dotGit)
    await write(join(dotGit, 'commondir'))
  }
  const cases = [
    ['unrecognized gitfile', path => writeFile(path, gitDir)],
    ['gitfile without a path', path => writeFile(path, 'gitdir: \n')],
    ['gitfile with extra content', path => writeFile(path, `gitdir: ${gitDir}\nextra line\n`)],
    ['gitfile with malformed UTF-8', path => writeFile(path, Buffer.from([0xff]))],
    ['oversized gitfile', path => writeFile(path, `gitdir: ${gitDir}${'\n'.repeat(1024 * 1024)}`)],
    ['gitfile with dangling target', path => writeFile(path, `gitdir: ${missing}\n`)],
    ['gitfile with dangling path component', path => writeFile(path, `gitdir: ${gitDir}/missing/..\n`)],
    ['gitfile targeting an unrelated directory', path => writeFile(path, `gitdir: ${notGit}\n`)],
    ['dangling dot-git symlink', path => symlink(missing, path, 'dir')],
    ['empty dot-git directory', path => mkdir(path)],
    ['invalid HEAD', async path => {
      await makeGitDir(path)
      await writeFile(join(path, 'HEAD'), 'not a ref or object ID\n')
    }],
    ['empty commondir', path => writeCommon(path, common => writeFile(common, '\n'))],
    ['non-file commondir', path => writeCommon(path, common => mkdir(common))],
    ['dangling commondir symlink', path => writeCommon(path, common => symlink(missing, common, 'file'))],
    ['commondir with a dangling target', path => writeCommon(path, common => writeFile(common, `${missing}\n`))],
    ['commondir targeting an unrelated directory', path => writeCommon(path, common => writeFile(common, `${notGit}\n`))],
  ]
  for (const [name, setup] of cases) {
    await t.test(name, async () => {
      const checkout = join(workspaceRoot, name)
      const nested = join(checkout, 'src')
      await mkdir(nested, { recursive: true })
      const dotGit = join(checkout, '.git')
      await setup(dotGit)
      await assert.rejects(resolveWorkspace(nested), { message: `Invalid OptMem Git metadata: ${dotGit}` })
    })
  }
})

test('only existing absolute directories can be resolved', async t => {
  const { root } = await fixture(t)
  const file = join(root, 'ordinary file')
  await writeFile(file, '')
  await assert.rejects(resolveWorkspace('workspace'), /absolute path/)
  await assert.rejects(resolveWorkspace(join(root, 'missing')), { code: 'ENOENT' })
  await assert.rejects(resolveWorkspace(file), /not a directory/)
})

test('construction and empty reads leave a missing file and its parent absent', async t => {
  const { directory, workspaceKey, database, store } = await fixture(t)
  await absent(directory)
  assert.deepEqual(store.search(workspaceKey, 'no match', 8), emptySearch)
  assert.equal(store.get(workspaceKey, 'missing'), null)
  await absent(directory)
  await mkdir(directory)
  assert.deepEqual(store.search(workspaceKey, '', 8), emptySearch)
  assert.equal(store.get(workspaceKey, 'missing'), null)
  await absent(database)
  assert.deepEqual(await readdir(directory), [])
})

test('validation refuses invalid workspace keys and text before creating any database', async t => {
  const { workspaceKey, workspaceRoot, directory, store } = await fixture(t)
  for (const text of [' ', 'first\nsecond', 'x\u2028y', 'x\0y', '\ud800', '记'.repeat(401)]) {
    assert.throws(() => store.save(workspaceKey, text))
  }
  assert.throws(() => store.search(workspaceKey, '记'.repeat(86), 10), /256 UTF-8 bytes/)
  assert.throws(() => store.search(workspaceKey, '', -1), /search limit/)
  for (const key of [workspaceRoot, 'relative', 'git:', 'dir:relative', `other:${workspaceRoot}`, `${workspaceKey}\0`, null]) {
    assert.throws(() => store.save(key, 'valid'), /workspace key/)
  }
  await absent(directory)
})

test('saved text survives reopening without rewriting in the first-release layout', async t => {
  const { workspaceKey, directory, database, store } = await fixture(t)
  const text = `  ${'记忆'.repeat(199)}尾 `
  assert.equal(Buffer.byteLength(text), 1200)
  const saved = store.save(workspaceKey, text)
  assert.match(saved.id, UUID_V4)
  assert.equal(saved.text, text)
  assert.equal(new Date(saved.createdAt).toISOString(), saved.createdAt)
  assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'id', 'text'])
  const reopened = createMemoryStore(database)
  assert.deepEqual(reopened.get(workspaceKey, saved.id), saved)
  assert.equal(reopened.get(workspaceKey, 'missing'), null)
  const result = reopened.search(workspaceKey, '尾 ', 8)
  assert.equal(result.hasMore, false)
  assert.equal(result.matches.length, 1)
  const [match] = result.matches
  assert.deepEqual(Object.keys(match).sort(), ['createdAt', 'id', 'summary', 'truncated'])
  assert.equal(match.id, saved.id)
  assert.equal(match.createdAt, saved.createdAt)
  assert.equal(match.truncated, true)
  assert.ok(match.summary.endsWith('…'))
  assert.ok(Buffer.byteLength(match.summary) <= 240)
  assert.ok(text.startsWith(match.summary.slice(0, -1)))
  assert.equal(match.summary.isWellFormed(), true)
  const raw = new DatabaseSync(database, { readOnly: true })
  try {
    const columns = raw.prepare('PRAGMA table_info(optmem_entries)').all().map(column => column.name)
    assert.deepEqual(columns, ['seq', 'workspace', 'id', 'text', 'created_at'])
  } finally {
    raw.close()
  }
  if (process.geteuid) {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(database)).mode & 0o777, 0o600)
  }
  assert.deepEqual(await readdir(directory), ['notes # 100% ?.sqlite'])
})

test('search matches literal substrings in Unicode caseless form and orders equal timestamps by write order', async t => {
  const { workspaceKey, store } = await fixture(t)
  const now = '2026-01-02T03:04:05.678Z'
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) })
  const old = store.save(workspaceKey, '中文 CAFÉ Σ 100% _ [x] .* \\^ ? $ ( ) { } | +')
  const decoy = store.save(workspaceKey, 'CAFé σ 100A x asterisk')
  const latest = store.save(workspaceKey, '中文 café ς 100% _ [X] .* \\^ ? $ ( ) { } | +')
  assert.equal(old.createdAt, now)
  assert.equal(latest.createdAt, now)
  const map = query => store.search(workspaceKey, query, 8).matches.map(({ id }) => id)
  for (const query of ['中文', '100%', '%', '_', '[x]', '.*', '\\^', '?', '$', '( )', '{ }', '|', '+']) {
    assert.deepEqual(map(query), [latest.id, old.id], JSON.stringify(query))
  }
  assert.deepEqual(map('café σ'), [latest.id, decoy.id, old.id])
  assert.deepEqual(map("' OR 1=1; --"), [])
  assert.deepEqual(map('  café'), [])
  assert.deepEqual(store.search(workspaceKey, '中文', 1), {
    matches: [{ id: latest.id, summary: latest.text, truncated: false, createdAt: now }],
    hasMore: true,
  })
  assert.deepEqual(store.search(workspaceKey, '中文', 0), { matches: [], hasMore: true })
  assert.equal(store.search(workspaceKey, '中文', 2).hasMore, false)
  assert.deepEqual(map(''), [latest.id, decoy.id, old.id])
})

test('empty files, foreign databases including WAL, and tagged databases with the wrong layout are left unchanged', async t => {
  const { root, workspaceKey } = await fixture(t)
  for (const kind of ['empty', 'foreign', 'wal', 'wrong layout']) {
    const directory = join(root, kind)
    await mkdir(directory, { mode: 0o700 })
    const path = join(directory, 'unrelated.sqlite')
    await writeFile(path, '', { mode: 0o600 })
    if (kind !== 'empty') {
      const foreign = new DatabaseSync(path)
      try {
        foreign.exec('CREATE TABLE unrelated (value TEXT)')
        foreign.prepare('INSERT INTO unrelated VALUES (?)').run('keep me')
        if (kind === 'wal') foreign.exec('PRAGMA journal_mode = WAL')
        if (kind === 'wrong layout') foreign.exec('PRAGMA application_id = 0x4f50544d')
      } finally {
        foreign.close()
      }
    }
    const before = await readFile(path)
    const store = createMemoryStore(path)
    const error = kind === 'wrong layout' ? /Unsupported OptMem database schema/ : /Not an OptMem database/
    assert.throws(() => store.search(workspaceKey, '', 8), error)
    assert.throws(() => store.get(workspaceKey, 'unknown'), error)
    assert.throws(() => store.save(workspaceKey, 'must not overwrite'), error)
    assert.deepEqual(await readFile(path), before)
    assert.deepEqual(await readdir(directory), ['unrelated.sqlite'])
  }
})

test('symlink targets, insecure permissions and orphaned sidecars fail instead of selecting another file', async t => {
  const { root, database, directory, workspaceKey, store } = await fixture(t)
  const original = store.save(workspaceKey, 'original')
  const alias = join(root, 'database-alias.sqlite')
  const aliasDirectory = join(root, 'directory-alias')
  await symlink(database, alias, 'file')
  await symlink(directory, aliasDirectory, 'dir')
  assert.throws(() => createMemoryStore(alias).save(workspaceKey, 'unexpected'), /private regular/)
  assert.throws(() => createMemoryStore(join(aliasDirectory, 'other.sqlite')).search(workspaceKey, '', 8), /regular OptMem database directory/)

  const orphan = join(root, 'missing.sqlite')
  await writeFile(`${orphan}-journal`, 'unrelated file', { mode: 0o600 })
  assert.deepEqual(createMemoryStore(orphan).search(workspaceKey, '', 8), emptySearch)
  assert.throws(() => createMemoryStore(orphan).save(workspaceKey, 'unexpected'), /orphaned SQLite sidecar/i)
  await absent(orphan)
  assert.equal(await readFile(`${orphan}-journal`, 'utf8'), 'unrelated file')

  if (process.geteuid) {
    await chmod(database, 0o644)
    assert.throws(() => store.get(workspaceKey, original.id), /private regular/)
    assert.throws(() => store.save(workspaceKey, 'unexpected'), /private regular/)
    assert.equal((await lstat(database)).mode & 0o777, 0o644)
    await chmod(database, 0o600)
  }
  assert.deepEqual(store.get(workspaceKey, original.id), original)
  assert.equal(store.search(workspaceKey, '', 8).matches.length, 1)
})

const writerScript = [
  "import { parentPort, workerData } from 'node:worker_threads'",
  'const input = workerData ?? JSON.parse(process.argv[1])',
  'const { createMemoryStore } = await import(input.moduleURL)',
  'const channel = parentPort ?? process',
  'const send = message => parentPort ? parentPort.postMessage(message) : process.send(message)',
  "const gate = new Promise(resolve => channel.once('message', resolve))",
  "send('ready')",
  'await gate',
  'const store = createMemoryStore(input.database)',
  'const records = Array.from({ length: 6 }, (_, offset) =>',
  '  store.save(input.workspaceKey, `entry ${input.worker}:${offset}`))',
  'send(records)',
  'if (!parentPort) process.disconnect()',
].join('\n')

function startWriter(input) {
  const inProcess = input.worker % 2 === 0
  const actor = inProcess
    ? new Worker(new URL(`data:text/javascript,${encodeURIComponent(writerScript)}`), { workerData: input })
    : spawn(process.execPath, ['--input-type=module', '-e', writerScript, JSON.stringify(input)],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const ready = Promise.withResolvers()
  let records
  let error
  let exited = false
  actor.on('message', message => {
    if (message === 'ready') ready.resolve()
    else records = message
  })
  actor.once('error', cause => { error = cause })
  const finished = new Promise(resolve => actor.once('exit', code => {
    exited = true
    if (error || code !== 0 || !records) {
      error ??= new Error(`SQLite writer ${input.worker} exited with ${code} without returning its records.`)
      ready.reject(error)
    }
    resolve({ records, error })
  }))
  return {
    ready: ready.promise,
    finished,
    run: () => inProcess ? actor.postMessage('run') : actor.send('run'),
    async stop() {
      if (exited) return
      if (inProcess) await actor.terminate()
      else actor.kill()
      await finished
    },
  }
}

test('concurrent first writes across threads and processes publish one database and keep all records', { timeout: 20_000 }, async t => {
  const { database, directory, workspaceKey, store } = await fixture(t)
  const moduleURL = new URL('../memory-store.js', import.meta.url).href
  const writers = Array.from({ length: 8 }, (_, worker) => startWriter({ database, workspaceKey, moduleURL, worker }))
  try {
    await Promise.all(writers.map(writer => writer.ready))
    await absent(directory)
    for (const writer of writers) writer.run()
    const stored = []
    for (const result of await Promise.all(writers.map(writer => writer.finished))) {
      if (result.error) throw result.error
      stored.push(...result.records)
    }
    const result = store.search(workspaceKey, 'entry', 48)
    assert.equal(result.hasMore, false)
    assert.equal(result.matches.length, 48)
    assert.equal(new Set(result.matches.map(({ id }) => id)).size, 48)
    assert.deepEqual(new Set(result.matches.map(({ summary }) => summary)), new Set(stored.map(({ text }) => text)))
    for (const record of stored) assert.deepEqual(store.get(workspaceKey, record.id), record)
    assert.deepEqual(await readdir(directory), ['notes # 100% ?.sqlite'])
  } finally {
    await Promise.all(writers.map(writer => writer.stop()))
  }
})

test('an occupied write lock surfaces an error and leaves no partial record', async t => {
  const { database, workspaceKey, store } = await fixture(t)
  store.save(workspaceKey, 'before lock')
  const lock = new DatabaseSync(database)
  try {
    lock.exec('BEGIN IMMEDIATE')
    assert.throws(() => store.save(workspaceKey, 'blocked save'), /database is locked/i)
    lock.exec('ROLLBACK')
  } finally {
    lock.close()
  }
  assert.deepEqual(store.search(workspaceKey, 'blocked save', 8), emptySearch)
  assert.ok(store.save(workspaceKey, 'after lock'))
})
