import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { DSH_INSTALL_DIR: installDir, DSH_NODE_EXECUTABLE: nodeExecutable } = process.env
const hostOptions = {
  skip: !installDir || !nodeExecutable ? 'Set DSH_INSTALL_DIR and DSH_NODE_EXECUTABLE to run the installed DSH Host tests' : false,
  timeout: 20_000,
}
const selection = { provider: 'fixture', model: 'fixture' }
const emptySearch = { status: 'ok', matches: [], hasMore: false }
const fixtureText = 'Synthetic records must never turn into [fixture-auto-context] instructions.'
const unusedId = '11111111-1111-4111-8111-111111111111'

async function createRepository(workspace) {
  const commonDir = join(workspace, '.git')
  await Promise.all([
    mkdir(join(commonDir, 'objects'), { recursive: true }),
    mkdir(join(commonDir, 'refs', 'heads'), { recursive: true }),
  ])
  await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
  return commonDir
}

async function linkWorktree(workspace, commonDir, branch) {
  const gitDir = join(commonDir, 'worktrees', branch)
  const gitFile = join(workspace, '.git')
  await Promise.all([workspace, gitDir].map(path => mkdir(path, { recursive: true })))
  await Promise.all([
    writeFile(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`),
    writeFile(join(gitDir, 'commondir'), '../..\n'),
    writeFile(join(gitDir, 'gitdir'), `${gitFile}\n`),
  ])
  await writeFile(gitFile, `gitdir: ${gitDir}\n`)
}

async function fixture(t, config) {
  let base = await realpath(homedir())
  for (const segment of ['tmp', 'dsh-plugin', 'optmem-sqlite']) {
    base = join(base, segment)
    await mkdir(base, { recursive: true })
    assert.equal(await realpath(base), base)
  }
  const root = await mkdtemp(join(base, 'host-'))
  assert.equal(dirname(root), base)
  assert.equal(await realpath(root), root)
  let ctx
  t.after(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const workspace = join(root, 'workspace A')
  const other = join(root, 'workspace B')
  const home = join(root, 'dsh-home')
  const profileContext = { name: 'fixture', home, dir: join(home, 'profiles', 'fixture') }
  const database = join(home, 'data', 'optmem', 'memory.sqlite')
  await mkdir(profileContext.dir, { recursive: true })
  const [commonDir, otherCommonDir] = await Promise.all([workspace, other].map(createRepository))

  assert.ok(isAbsolute(installDir) && isAbsolute(nodeExecutable), 'Use absolute DSH installation and executable paths')
  const installAnchor = join(installDir, 'package.json')
  const manifest = JSON.parse(await readFile(installAnchor, 'utf8'))
  assert.equal(manifest.name, '@deepseek-ai/dsh')
  await access(nodeExecutable)
  const fromInstallation = createRequire(installAnchor)
  const boot = await import(pathToFileURL(fromInstallation.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { Context } = await import(pathToFileURL(fromInstallation.resolve('@deepseek-ai/cordis')).href)
  const installed = await boot.createRuntimeResolution({ installAnchor, home })
  const bundleDir = await realpath(fileURLToPath(new URL('../', import.meta.url)))
  const resolution = {
    ...installed,
    linkedRoots: [{ name: '@local/dsh-optmem', realPath: bundleDir }],
  }
  ctx = new Context()
  await ctx.plugin(boot.PluginPackages, { resolution })
  ctx.provide('profileContext', profileContext)

  function dsh(key) {
    const name = `@deepseek-ai/dsh-${key}`
    const entry = resolution.entries.find(entry => entry.name === name)
    assert.ok(entry, `${name} is missing from the installed DSH runtime`)
    return import(pathToFileURL(createRequire(entry.declarer).resolve(name)).href)
  }
  const service = async (name, options) => await ctx.plugin((await dsh(name)).default, options)
  const llm = await dsh('llm')
  const requests = []
  class FixtureAdapter extends llm.LlmAdapter {
    async *stream(request) {
      requests.push({ messages: request.messages, system: request.system, tools: request.tools })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic reply.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  await ctx.plugin(llm.default)
  ctx.llm.registerAdapter([selection.provider], new FixtureAdapter())
  for (const name of ['session', 'session-projection', 'system-prompt', 'fs-local', 'working-directory',
    'agent', 'tools', 'agent-loop', 'user-questions']) await service(name)
  const nativeExecutor = await ctx.plugin(await dsh('tool-executor-native'))
  const createAgent = (sessionId, meta) => ctx.agents.create({
    sessionId, meta: { cwd: workspace, ...meta }, agentOptions: selection,
  })
  const { agent } = await createAgent('fixture-primary')
  const questions = []
  let responder
  ctx.on('user-questions/request', (request, next) => {
    questions.push(request)
    return responder === undefined ? next() : responder(request)
  }, { global: true })
  const optmem = await import('../index.js')
  async function mountMemo(name = profileContext.name, dshHome = home) {
    if (name === profileContext.name && dshHome === home) return await ctx.plugin(optmem, config)
    const owner = ctx.isolate('profileContext')
    const dir = join(dshHome, 'profiles', name)
    await mkdir(dir, { recursive: true })
    owner.provide('profileContext', { name, home: dshHome, dir })
    return await owner.plugin(optmem, config)
  }
  const plugin = await mountMemo()
  let sequence = 0
  async function execute(name, args, caller = agent) {
    const signal = t.signal
    const toolSet = await ctx.tools.resolve({ agent: caller, modelSelection: selection, signal })
    try {
      const { results: [{ result }] } = await ctx.tools.execute({
        toolSet, agent: caller, signal,
        calls: [{ type: 'tool-call', id: `fixture-call-${++sequence}`, name, arguments: JSON.stringify(args) }],
      })
      return result
    } finally {
      toolSet.dispose()
    }
  }
  return {
    ctx, root, workspace, other, commonDir, otherCommonDir, database,
    agent, createAgent, questions, requests, plugin, mountMemo,
    userMessage: text => llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
    respond: answer => { responder = answer },
    raw: (args, caller) => execute('memo', args, caller),
    async memo(args, caller) { return valueOf(await execute('memo', args, caller)) },
    async useCodeMode() {
      await nativeExecutor.dispose()
      for (const name of ['subprocess-local', 'sandbox-local']) await service(name)
      await service('sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root })
      await service('ptc-runtime-node', { launch: { kind: 'node-script', executable: nodeExecutable } })
      await ctx.plugin(await dsh('tool-executor-ptc'))
    },
    async code(source) {
      return valueOf(await execute('run_code', { code: source, description: 'Exercise OptMem with synthetic records' })).logs
    },
  }
}

function valueOf(result) {
  assert.equal(result.isError, false, JSON.stringify(result.error ?? result.content))
  return result.value
}

function answer({ questions: [question] }, choice = 'approve') {
  return { answers: [{ id: question.id, selected: choice === 'skip' ? [] : [question.intent[choice]] }] }
}

function assertApproval(request, { agent, workspace, commonDir, database }, text) {
  assert.equal(request.agent, agent)
  assert.equal(request.questions.length, 1)
  const [question] = request.questions
  assert.equal(question.intent.kind, 'approval')
  assert.deepEqual(question.options.map(option => option.label), [question.intent.approve, question.intent.reject])
  for (const detail of [question.detail, question.intent.display.detail.en, question.intent.display.detail.zh]) {
    const lines = detail.split('\n')
    assert.ok(lines.includes(`    ${workspace}`), 'Approval detail contains the workspace root')
    if (commonDir) assert.ok(lines.includes(`    ${commonDir}`), 'Approval detail contains the Git common directory')
    assert.ok(lines.includes(`    ${database}`), 'Approval detail contains the database path')
    assert.ok(detail.endsWith(`\n    ${text}`), 'Approval detail contains the complete, exact note')
  }
}

function absent(path) { return assert.rejects(access(path), { code: 'ENOENT' }) }
const note = text => ({ action: 'note', text })
const search = query => ({ action: 'search', query })
const get = id => ({ action: 'get', id })

async function approveAfter(host, text, whileWaiting) {
  const asking = Promise.withResolvers()
  const completing = Promise.withResolvers()
  host.respond(request => {
    request.signal.addEventListener('abort', () => completing.resolve({ answers: [] }), { once: true })
    asking.resolve(request)
    return completing.promise
  })
  const pending = host.memo(note(text))
  try {
    const request = await Promise.race([asking.promise, pending.then(() => assert.fail('No confirmation was presented'))])
    await whileWaiting(request)
    completing.resolve(answer(request))
    return await pending
  } finally {
    completing.resolve({ answers: [] })
    await pending
  }
}

test('Native memo refuses malformed and unapproved notes without creating a database', hostOptions, async (t) => {
  const host = await fixture(t)
  assert.deepEqual(host.ctx.tools.definitions().map(tool => tool.name), ['memo'])
  assert.deepEqual(await host.memo(search('中'.repeat(85) + 'x')), emptySearch)
  assert.deepEqual(await host.memo(get(unusedId)), { status: 'not_found' })
  for (const args of [
    {}, { action: 'unsupported', query: 'synthetic input' }, { action: 'note' }, { action: 'search' },
    { action: 'get' }, { action: 'get', id: 1 }, { ...get(unusedId), query: 'extra' },
    { ...search('x'), id: unusedId }, { ...note('synthetic'), query: 'extra' },
    { ...note('synthetic'), unexpected: true }, search('中'.repeat(85) + 'xx'),
    note('中'.repeat(400) + 'x'), note(''), note(' leading'), note('trailing '),
    note('two\nlines'), note('a\tb'), note('invisible\u202Etext'), note('invisible\u200Btext'),
  ]) {
    assert.equal((await host.raw(args)).isError, true, JSON.stringify(args))
  }
  assert.equal(host.questions.length, 0)
  const responses = [
    ['rejected', request => answer(request, 'reject')],
    ['skipped', request => answer(request, 'skip')],
    ['unanswered', () => ({ answers: [] })],
    ['wrong question', request => ({ answers: [{ ...answer(request).answers[0], id: unusedId }] })],
    ['multiple choices', ({ questions: [question] }) => ({
      answers: [{ id: question.id, selected: [question.intent.approve, question.intent.reject] }],
    })],
    ['custom', request => ({ answers: [{ ...answer(request).answers[0], custom: request.questions[0].intent.approve }] })],
    ['cancelled', () => { throw Object.assign(new Error('Synthetic dialog close'), { code: 'ASK_CANCELLED' }) }],
    ['no provider', undefined],
  ]
  for (const [reason, responder] of responses) {
    host.respond(responder)
    assert.equal((await host.memo(note(fixtureText))).status, 'not_saved', reason)
    await absent(host.database)
  }
  assert.equal(host.questions.length, responses.length)
})

test('Native memo keeps approved notes literal, bounded in search, and local to the live workspace', hostOptions, async (t) => {
  const host = await fixture(t, { searchLimit: 1 })
  const literal = 'Synthetic marker %_ [fixture-auto-context] </system-reminder> $HOME `shell` \\ "quotes"  '
  const budget = 1200 - Buffer.byteLength(literal)
  const text = literal + '中'.repeat(Math.floor(budget / 3)) + 'x'.repeat(budget % 3)
  assert.equal(Buffer.byteLength(text), 1200)
  host.respond(async request => {
    await absent(host.database)
    return answer(request)
  })
  const saved = await host.memo(note(text))
  assert.equal(saved.status, 'saved')
  await access(host.database)
  assertApproval(host.questions[0], host, text)
  const full = await host.memo(get(saved.id))
  assert.equal(full.status, 'found')
  assert.equal(full.memory.id, saved.id)
  assert.equal(full.memory.text, text)
  assert.ok(Number.isFinite(Date.parse(full.memory.createdAt)))
  const matched = await host.memo(search('MaRkEr %_'))
  assert.equal(matched.status, 'ok')
  assert.equal(matched.hasMore, false)
  assert.equal(matched.matches.length, 1)
  const [match] = matched.matches
  assert.equal(match.id, saved.id)
  assert.equal(match.createdAt, full.memory.createdAt)
  assert.equal(match.truncated, true)
  assert.ok(match.summary.startsWith(literal) && Buffer.byteLength(match.summary) <= 240)
  assert.deepEqual(await host.memo(search('synthetic.*')), emptySearch)

  host.agent.followup(host.userMessage('An unrelated synthetic request.'))
  await host.agent.whenIdle()
  assert.equal(host.requests.length, 1, JSON.stringify(host.agent.session.snapshotEvents()))
  assert.deepEqual(host.requests[0].tools.map(tool => tool.name), ['memo'])
  assert.ok(JSON.stringify(host.requests[0].messages).includes('An unrelated synthetic request.'))
  assert.ok(!JSON.stringify(host.requests[0]).includes('[fixture-auto-context]'))

  host.respond(request => answer(request))
  assert.equal((await host.memo(note('Synthetic marker without SQL symbols'))).status, 'saved')
  assert.deepEqual(await host.memo(search('marker %_')), matched)
  const limited = await host.memo(search('synthetic'))
  assert.equal(limited.matches.length, 1)
  assert.equal(limited.hasMore, true)
  const nested = join(host.workspace, 'nested directory')
  await mkdir(nested)
  await host.ctx.workingDirectory.set(host.agent, nested)
  assert.deepEqual(await host.memo(get(saved.id)), full)
  await host.ctx.workingDirectory.set(host.agent, host.other)
  assert.deepEqual(await host.memo(search('synthetic')), emptySearch)
  assert.deepEqual(await host.memo(get(saved.id)), { status: 'not_found' })
  const otherNote = await host.memo(note('Synthetic workspace B note'))
  assert.equal(otherNote.status, 'saved')
  await host.ctx.workingDirectory.set(host.agent, host.workspace)
  assert.deepEqual(await host.memo(get(otherNote.id)), { status: 'not_found' })
  assert.deepEqual(await host.memo(get(saved.id)), full)

  const child = await host.createAgent('fixture-child', { origin: 'subagent', parentSession: host.agent.id })
  const inactive = await host.createAgent('fixture-inactive')
  await inactive.dispose()
  const askCount = host.questions.length
  for (const caller of [child.agent, inactive.agent]) {
    for (const args of [search('synthetic'), get(saved.id), note(fixtureText)]) {
      assert.equal((await host.raw(args, caller)).isError, true, caller.id)
    }
  }
  assert.equal(host.questions.length, askCount)
  assert.deepEqual(await host.memo(search('must never turn')), emptySearch)
})

test('The main checkout and linked worktrees on different branches share approved notes', hostOptions, async (t) => {
  const host = await fixture(t)
  const topic = join(host.root, 'topic worktree')
  const review = join(host.root, 'review worktree')
  const gitAlias = join(host.root, 'Git common directory alias')
  await symlink(host.commonDir, gitAlias, 'junction')
  await linkWorktree(topic, gitAlias, 'topic')
  await linkWorktree(review, host.commonDir, 'review')
  const nested = join(topic, 'nested directory')
  await mkdir(nested)
  const { agent: topicAgent } = await host.createAgent('fixture-topic', { cwd: nested })
  const { agent: reviewAgent } = await host.createAgent('fixture-review', { cwd: review })

  host.respond(request => answer(request))
  const main = await host.memo(note(fixtureText))
  assert.equal(main.status, 'saved')
  const full = await host.memo(get(main.id))
  const matches = await host.memo(search('fixture-auto-context'))
  assert.equal(full.memory.text, fixtureText)
  assert.deepEqual(matches.matches.map(({ id }) => id), [main.id])
  for (const caller of [topicAgent, reviewAgent]) {
    assert.deepEqual(await host.memo(get(main.id), caller), full)
    assert.deepEqual(await host.memo(search('fixture-auto-context'), caller), matches)
  }

  const text = 'Synthetic linked worktree note'
  host.respond(request => answer(request, 'reject'))
  assert.equal((await host.memo(note(text), topicAgent)).status, 'not_saved')
  assertApproval(host.questions.at(-1), { ...host, agent: topicAgent, workspace: topic }, text)
  for (const caller of [host.agent, topicAgent, reviewAgent]) {
    assert.deepEqual(await host.memo(search(text), caller), emptySearch)
  }

  host.respond(request => answer(request))
  const written = await host.memo(note(text), topicAgent)
  assert.equal(written.status, 'saved')
  assertApproval(host.questions.at(-1), { ...host, agent: topicAgent, workspace: topic }, text)
  for (const caller of [host.agent, topicAgent, reviewAgent]) {
    assert.equal((await host.memo(get(written.id), caller)).memory.text, text)
    assert.deepEqual((await host.memo(search(text), caller)).matches.map(({ id }) => id), [written.id])
  }
})

test('Non-Git directories use the exact current directory, separate from one another and from Git', hostOptions, async (t) => {
  const host = await fixture(t)
  const directory = join(host.root, 'standalone directory')
  const nested = join(directory, 'nested directory')
  await mkdir(nested, { recursive: true })
  const scopes = [
    { workspace: host.workspace, commonDir: host.commonDir, text: 'Synthetic isolated Git note' },
    { workspace: directory, commonDir: null, text: 'Synthetic isolated standalone note' },
    { workspace: nested, commonDir: null, text: 'Synthetic isolated nested note' },
  ]
  host.respond(request => answer(request))
  for (const scope of scopes) {
    await host.ctx.workingDirectory.set(host.agent, scope.workspace)
    const saved = await host.memo(note(scope.text))
    assert.equal(saved.status, 'saved')
    assertApproval(host.questions.at(-1), { ...host, ...scope }, scope.text)
    scope.id = saved.id
  }
  for (const scope of scopes) {
    await host.ctx.workingDirectory.set(host.agent, scope.workspace)
    assert.deepEqual((await host.memo(search('Synthetic isolated'))).matches.map(({ id }) => id), [scope.id])
    assert.equal((await host.memo(get(scope.id))).memory.text, scope.text)
    for (const other of scopes.filter(other => other !== scope)) {
      assert.deepEqual(await host.memo(get(other.id)), { status: 'not_found' })
    }
  }
})

test('Pending approval allows reads but cannot save after a linked-worktree switch, deadline, or unload', hostOptions, async (t) => {
  const host = await fixture(t)
  const linked = join(host.root, 'linked worktree')
  await linkWorktree(linked, host.commonDir, 'topic')
  host.respond(request => answer(request))
  const existing = await host.memo(note(fixtureText))
  assert.equal(existing.status, 'saved')
  const movingText = 'Synthetic pending workspace move'
  const moving = await approveAfter(host, movingText, async request => {
    assertApproval(request, host, movingText)
    assert.equal((await host.memo(get(existing.id))).memory.text, fixtureText)
    assert.deepEqual((await host.memo(search('fixture-auto-context'))).matches.map(match => match.id), [existing.id])
    assert.deepEqual(await host.memo(search('pending workspace move')), emptySearch)
    await host.ctx.workingDirectory.set(host.agent, linked)
    assert.equal((await host.memo(get(existing.id))).memory.text, fixtureText)
  })
  assert.equal(moving.status, 'not_saved')
  assert.deepEqual(await host.memo(search('pending workspace move')), emptySearch)
  await host.ctx.workingDirectory.set(host.agent, host.workspace)
  assert.deepEqual(await host.memo(search('pending workspace move')), emptySearch)

  const timeout = new AbortController()
  const realTimeout = AbortSignal.timeout
  const deadline = t.mock.method(AbortSignal, 'timeout', (ms) => ms === 90_000 ? timeout.signal : realTimeout(ms))
  host.respond(request => { timeout.abort(new DOMException('Synthetic deadline', 'TimeoutError')); return answer(request) })
  try {
    assert.equal((await host.memo(note('Synthetic expired write'))).status, 'not_saved')
    assert.equal(host.questions.at(-1).signal.aborted, true)
  } finally {
    deadline.mock.restore()
  }
  assert.deepEqual(await host.memo(search('expired write')), emptySearch)

  const awaitingUnload = Promise.withResolvers()
  const late = Promise.withResolvers()
  host.respond(request => {
    request.signal.addEventListener('abort', () => late.resolve(answer(request)), { once: true })
    awaitingUnload.resolve(request)
    return late.promise
  })
  const unloading = host.raw(note('Synthetic unloaded write'))
  try {
    const request = await Promise.race([awaitingUnload.promise, unloading.then(() => assert.fail('No confirmation was presented'))])
    await host.plugin.dispose()
    assert.ok(request.signal.aborted)
    assert.equal(host.ctx.tools.get('memo'), undefined)
    const result = await unloading
    assert.ok(result.isError || result.value.status === 'not_saved')
    assert.equal((await host.raw(search('synthetic'))).isError, true)
  } finally {
    late.resolve({ answers: [] })
    await unloading
  }
  await host.mountMemo()
  assert.equal((await host.memo(get(existing.id))).memory.text, fixtureText)
  assert.deepEqual(await host.memo(search('unloaded write')), emptySearch)
})

test('Pending approval requires the same valid Git association even when the CWD is unchanged', hostOptions, async (t) => {
  const host = await fixture(t)
  const linked = join(host.root, 'linked worktree')
  await linkWorktree(linked, host.commonDir, 'topic')
  host.respond(request => answer(request))
  const original = await host.memo(note('Synthetic original repository note'))
  await host.ctx.workingDirectory.set(host.agent, host.other)
  const newOwner = await host.memo(note('Synthetic reassociated repository note'))
  assert.equal(original.status, 'saved')
  assert.equal(newOwner.status, 'saved')
  await host.ctx.workingDirectory.set(host.agent, linked)
  assert.equal((await host.memo(get(original.id))).status, 'found')
  assert.deepEqual(await host.memo(get(newOwner.id)), { status: 'not_found' })

  const text = 'Synthetic pending reassociation note'
  const stale = await approveAfter(host, text, async request => {
    assertApproval(request, { ...host, workspace: linked }, text)
    await linkWorktree(linked, host.otherCommonDir, 'topic')
    assert.equal(host.ctx.workingDirectory.get(host.agent.session), linked)
    assert.deepEqual(await host.memo(get(original.id)), { status: 'not_found' })
    assert.equal((await host.memo(get(newOwner.id))).status, 'found')
  })
  assert.equal(stale.status, 'not_saved')
  assert.deepEqual(await host.memo(search(text)), emptySearch)

  const unverifiableText = 'Synthetic pending unverifiable workspace note'
  const unverifiable = await approveAfter(host, unverifiableText, async () => {
    await writeFile(join(linked, '.git'), 'gitdir: ../missing-metadata\n')
    assert.equal((await host.raw(get(newOwner.id))).isError, true)
  })
  assert.equal(unverifiable.status, 'not_saved')
  assert.match(unverifiable.message, /could no longer be verified/)
  await linkWorktree(linked, host.otherCommonDir, 'topic')
  assert.deepEqual(await host.memo(search(unverifiableText)), emptySearch)
  await host.ctx.workingDirectory.set(host.agent, host.workspace)
  assert.deepEqual(await host.memo(search(text)), emptySearch)
  assert.deepEqual(await host.memo(search(unverifiableText)), emptySearch)
})

test('Different profiles in one DSH home share approved notes for the same workspace', hostOptions, async (t) => {
  const host = await fixture(t)
  host.respond(request => answer(request))
  const saved = await host.memo(note(fixtureText))
  assert.equal(saved.status, 'saved')
  await host.plugin.dispose()

  const alternate = await host.mountMemo('fixture-alternate')
  assert.equal((await host.memo(get(saved.id))).memory.text, fixtureText)
  assert.deepEqual((await host.memo(search('fixture-auto-context'))).matches.map(({ id }) => id), [saved.id])
  const text = 'Synthetic alternate profile note'
  const other = await host.memo(note(text))
  assert.equal(other.status, 'saved')
  assertApproval(host.questions.at(-1), host, text)
  await alternate.dispose()

  await host.mountMemo()
  assert.equal((await host.memo(get(other.id))).memory.text, text)
  assert.deepEqual((await host.memo(search('alternate profile'))).matches.map(({ id }) => id), [other.id])
})

test('Identically named profiles in different DSH homes keep notes separate for the same workspace', hostOptions, async (t) => {
  const host = await fixture(t)
  host.respond(request => answer(request))
  const saved = await host.memo(note(fixtureText))
  assert.equal(saved.status, 'saved')
  await host.plugin.dispose()

  const separateHome = join(host.root, 'separate-dsh-home')
  const separateDatabase = join(separateHome, 'data', 'optmem', 'memory.sqlite')
  const alternate = await host.mountMemo(undefined, separateHome)
  assert.deepEqual(await host.memo(get(saved.id)), { status: 'not_found' })
  assert.deepEqual(await host.memo(search('fixture-auto-context')), emptySearch)
  await absent(separateDatabase)
  const text = 'Synthetic separate home note'
  const other = await host.memo(note(text))
  assert.equal(other.status, 'saved')
  assertApproval(host.questions.at(-1), { ...host, database: separateDatabase }, text)
  await access(separateDatabase)
  assert.equal((await host.memo(get(other.id))).memory.text, text)
  await alternate.dispose()

  await host.mountMemo()
  assert.deepEqual(await host.memo(get(other.id)), { status: 'not_found' })
  assert.deepEqual(await host.memo(search(text)), emptySearch)
  assert.equal((await host.memo(get(saved.id))).memory.text, fixtureText)
})

test('Code Mode tools.memo reads native records and asks before writing through the same Host store', hostOptions, async (t) => {
  const host = await fixture(t)
  host.respond(request => answer(request))
  const { id } = await host.memo(note(fixtureText))
  const native = await host.memo(get(id))
  await host.useCodeMode()
  assert.equal((await host.raw(get(id))).isError, true)
  const read = await host.code([
    `const found = await tools.memo(${JSON.stringify(search('fixture-auto-context'))})`,
    'inspect(JSON.stringify(await tools.memo({ action: "get", id: found.matches[0].id })))',
  ].join('\n'))
  assert.deepEqual(JSON.parse(read.join('')), native)

  const text = 'Synthetic Code Mode write'
  host.respond(request => answer(request, 'reject'))
  const propose = `inspect(JSON.stringify(await tools.memo(${JSON.stringify(note(text))})))`
  assert.equal(JSON.parse((await host.code(propose)).join('')).status, 'not_saved')
  assertApproval(host.questions.at(-1), host, text)
  host.respond(request => answer(request))
  const written = JSON.parse((await host.code(propose)).join(''))
  assert.equal(written.status, 'saved')
  const reread = await host.code(`inspect(JSON.stringify(await tools.memo(${JSON.stringify(get(written.id))})))`)
  assert.equal(JSON.parse(reread.join('')).memory.text, text)
})
