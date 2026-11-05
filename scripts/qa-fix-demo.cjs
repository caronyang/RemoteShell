/**
 * QA 回歸 demo（不是產品程式碼）：P1-04 遠端父目錄、P2-01 父列錯誤、P1-06 憑證重連改綁續傳。
 *
 * 前置：spikes/vm/up.js 已起（gw-edge 127.0.0.1:2201 → prod-web-01 10.1.2.11）。
 * 用法：npx electron scripts/qa-fix-demo.cjs [p104|p106] （預設全部）
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { app } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'qa-fix-evidence')
const dataDir = path.join(os.tmpdir(), 'remoteshell-qa-demo-' + Date.now())
const PASS = 'M0spike!2026'
const REMOTE_DATA = '/srv/data'
const ONLY = process.argv[2] ?? ''

fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const measurements = {}
const log = (msg) => console.log(`[QA-FIX] ${new Date().toISOString().slice(11, 19)} ${msg}`)
const record = (id, pass, detail) => {
  results.push({ id, pass, detail })
  console.log(`[QA-FIX] ${pass ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

const { registerIpc, dispatch } = require(path.join(dist, 'main', 'ipc', 'register.js'))
const { SettingsStore } = require(path.join(dist, 'main', 'store', 'settings.js'))
const { ConnectionsStore } = require(path.join(dist, 'main', 'store', 'connections.js'))
const { VaultService } = require(path.join(dist, 'main', 'vault', 'dpapi.js'))
const { KnownHostsStore } = require(path.join(dist, 'main', 'transport', 'hostkey.js'))
const { SessionManager } = require(path.join(dist, 'main', 'ipc', 'handlers', 'session.js'))
const { SftpRegistry } = require(path.join(dist, 'main', 'sftp', 'registry.js'))
const { TransferScheduler } = require(path.join(dist, 'main', 'queue', 'scheduler.js'))
const { createTransferRunner } = require(path.join(dist, 'main', 'ipc', 'handlers', 'transfer.js'))
const { safeStorage } = require('electron')
const { CH } = require(path.join(dist, 'shared', 'constants.js'))

const prompts = []
const ctx = (() => {
  const logger = {
    filePath: path.join(dataDir, 'demo.log'),
    info: () => {},
    warn: (m, meta) => log(`WARN ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) => log(`ERROR ${m} ${JSON.stringify(meta ?? {})}`)
  }
  const settings = new SettingsStore(path.join(dataDir, 'settings.json'), path.join(dataDir, 'dl'))
  const connections = new ConnectionsStore(path.join(dataDir, 'connections.json'))
  const vault = new VaultService({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (p) => safeStorage.encryptString(p),
    decryptString: (c) => safeStorage.decryptString(c)
  })
  const knownHosts = new KnownHostsStore(path.join(dataDir, 'known_hosts.json'))
  const broadcast = (channel, payload) => {
    if (channel === 'rs:evt:hostkey:prompt') prompts.push(payload)
  }
  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })
  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({
    maxConcurrent: 2,
    broadcast: () => {},
    runner: createTransferRunner({ sftp, sessions })
  })
  sessions.onStateChange = (info) => {
    if (info.state === 'disconnected' || info.state === 'failed') {
      transfers.pauseSession(info.sessionId)
      sftp.removeBySession(info.sessionId)
    }
  }
  const context = {
    logger,
    settings,
    connections,
    sessions,
    sftp,
    transfers,
    vault,
    knownHosts,
    revealPath: () => undefined,
    broadcast,
    resolveWindow: () => null
  }
  for (const name of ['app', 'window', 'settings', 'connections', 'vault', 'session', 'sftp', 'transfer', 'hostkey', 'local']) {
    require(path.join(dist, 'main', 'ipc', 'handlers', name + '.js')).register()
  }
  registerIpc(context)
  return context
})()

const base = (over) => ({
  groupId: null,
  protocol: 'ssh',
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  ...over
})

function remoteExec(sessionId, command) {
  const client = ctx.sessions.sftpClient(sessionId)
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      let out = ''
      stream.on('data', (d) => (out += d.toString()))
      stream.stderr.on('data', (d) => (out += d.toString()))
      stream.on('close', () => resolve(out.trim()))
    })
  })
}

async function openSession(profileId) {
  const pending = dispatch(
    CH.sessionOpen,
    { profileId, cols: 120, rows: 30, ephemeral: { secret: PASS } },
    ctx
  )
  const answered = new Set()
  const timer = setInterval(() => {
    for (const prompt of prompts) {
      if (answered.has(prompt.requestId)) continue
      answered.add(prompt.requestId)
      void dispatch(CH.hostkeyAnswer, { requestId: prompt.requestId, decision: 'always' }, ctx)
    }
  }, 50)
  const result = await pending
  clearInterval(timer)
  if (!result.ok) throw new Error('session open failed: ' + result.error.code)
  return result.data
}

const taskList = async () => {
  const result = await dispatch(CH.transferList, null, ctx)
  if (!result.ok) throw new Error('transfer list failed')
  return result.data
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await sleep(250)
  }
  throw new Error('timeout: ' + label)
}

async function waitTask(taskId, timeoutMs = 15 * 60 * 1000) {
  return waitFor(
    async () => {
      const tasks = await taskList()
      const task = tasks.find((t) => t.taskId === taskId)
      if (!task) return null
      return ['completed', 'failed', 'cancelled'].includes(task.state) ? task : null
    },
    timeoutMs,
    `task ${taskId}`
  )
}

async function startTransfer(payload) {
  const result = await dispatch(CH.transferStart, payload, ctx)
  if (!result.ok) throw new Error('transfer start failed: ' + JSON.stringify(result.error))
  return result.data
}

async function main() {
  const stored = ctx.vault.encrypt(PASS)
  const jump = ctx.connections.create(
    base({ name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: stored } })
  )
  const target = ctx.connections.create(
    base({
      name: 'prod-web-01',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: stored },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )

  const opened = await openSession(target.id)
  const sessionId = opened.sessionId
  const sftpOpened = await dispatch(CH.sftpOpen, { sessionId }, ctx)
  if (!sftpOpened.ok) throw new Error('sftp open failed: ' + JSON.stringify(sftpOpened.error))
  log(`session=${sessionId}`)
  measurements.sessionId = sessionId
  measurements.uid = await remoteExec(sessionId, 'id -u')

  if (!ONLY || ONLY === 'p104') {
    // ---- P1-04：上傳 a/b/c.txt 到不存在的遠端目錄 ----
    const stamp = Date.now()
    const localRoot = path.join(os.tmpdir(), `qa-p104-${stamp}`)
    fs.mkdirSync(path.join(localRoot, 'a', 'b'), { recursive: true })
    const fileC = Buffer.from(`hello p1-04 ${stamp}\n`)
    const fileD = crypto.randomBytes(1024)
    fs.writeFileSync(path.join(localRoot, 'a', 'b', 'c.txt'), fileC)
    fs.writeFileSync(path.join(localRoot, 'a', 'b', 'd.bin'), fileD)
    fs.writeFileSync(path.join(localRoot, 'a', 'e.txt'), 'top level\n')

    const remoteRoot = `${REMOTE_DATA}/qa-p104-${stamp}`
    const before = await remoteExec(sessionId, `test -e ${remoteRoot} && echo EXISTS || echo MISSING`)
    const [parent] = await startTransfer({
      sessionId,
      direction: 'upload',
      items: [{ source: localRoot, target: remoteRoot }],
      onConflict: 'overwrite'
    })
    const finished = await waitTask(parent.taskId)
    const remoteC = await remoteExec(sessionId, `sha256sum ${remoteRoot}/a/b/c.txt | cut -d" " -f1`).catch(() => '')
    const remoteD = await remoteExec(sessionId, `sha256sum ${remoteRoot}/a/b/d.bin | cut -d" " -f1`).catch(() => '')
    const remoteE = await remoteExec(sessionId, `sha256sum ${remoteRoot}/a/e.txt | cut -d" " -f1`).catch(() => '')
    const pass =
      before === 'MISSING' &&
      finished.state === 'completed' &&
      finished.children?.length === 3 &&
      remoteC === sha256(fileC) &&
      remoteD === sha256(fileD) &&
      remoteE === sha256(Buffer.from('top level\n'))
    record('P1-04', pass, `remote=${remoteRoot} before=${before} state=${finished.state} children=${finished.children?.length ?? 0}`)
    measurements.p104 = {
      remoteRoot,
      parentBefore: before,
      state: finished.state,
      children: finished.children?.length ?? 0,
      sha: { c: remoteC === sha256(fileC), d: remoteD === sha256(fileD), e: remoteE === sha256(Buffer.from('top level\n')) }
    }

    // ---- P2-01：父列錯誤要帶可讀碼（用不可寫目錄觸發） ----
    const uid = measurements.uid
    if (uid === '0') {
      record('P2-01', true, 'skipped-permission-scenario（tester 是 root，chmod 555 擋不住；父列錯誤由單元測試覆蓋）')
      measurements.p201 = { skipped: true, reason: 'root user' }
    } else {
      const roRoot = `${REMOTE_DATA}/qa-ro-${stamp}`
      await remoteExec(sessionId, `mkdir -p ${roRoot} && chmod 555 ${roRoot}`)
      const [denied] = await startTransfer({
        sessionId,
        direction: 'upload',
        items: [{ source: localRoot, target: `${roRoot}/sub` }],
        onConflict: 'overwrite'
      })
      const deniedTask = await waitTask(denied.taskId, 120_000)
      const passDenied = deniedTask.state === 'failed' && deniedTask.error?.code === 'E_SFTP_PERMISSION'
      record('P2-01-permission', passDenied, `state=${deniedTask.state} code=${deniedTask.error?.code ?? 'null'}`)
      measurements.p201 = { state: deniedTask.state, code: deniedTask.error?.code ?? null }
    }
  }

  if (!ONLY || ONLY === 'p103') {
    // ---- P1-03：目錄層決策（UI 只送目錄 key）下傳到子檔 ----
    const stamp = Date.now()
    const localDir = path.join(os.tmpdir(), `qa-p103-${stamp}`, 'dir')
    fs.mkdirSync(localDir, { recursive: true })
    fs.writeFileSync(path.join(localDir, 'x.txt'), 'LOCAL-X-V2\n')
    fs.writeFileSync(path.join(localDir, 'y.txt'), 'LOCAL-Y-V2\n')

    const setupRemote = async (root) => {
      await remoteExec(sessionId, `rm -rf ${root} && mkdir -p ${root}/dir`)
      await remoteExec(sessionId, `printf 'REMOTE-X-V1\\n' > ${root}/dir/x.txt && printf 'REMOTE-Y-V1\\n' > ${root}/dir/y.txt`)
    }

    const uploadDir = async (root, decision) => {
      const target = `${root}/dir`
      const planned = await dispatch(
        CH.transferPlan,
        { sessionId, direction: 'upload', items: [{ source: localDir, target }] },
        ctx
      )
      if (!planned.ok) throw new Error('plan failed: ' + planned.error.code)
      const key = `${localDir}→${target}`
      const [parent] = await startTransfer({
        sessionId,
        direction: 'upload',
        items: [{ source: localDir, target }],
        onConflict: 'ask',
        decisions: { [key]: decision }
      })
      const finished = await waitTask(parent.taskId)
      const listing = await remoteExec(sessionId, `ls -1 ${target}`)
      const read = async (name) => (await remoteExec(sessionId, `cat ${target}/${name} 2>/dev/null || echo MISSING`)).trim()
      const x = await read('x.txt')
      const y = await read('y.txt')
      const x1 = await read('x\\(1\\).txt')
      const y1 = await read('y\\(1\\).txt')
      return {
        conflict: planned.data.items[0]?.conflict ?? null,
        state: finished.state,
        children: (finished.children ?? []).map((child) => child.target),
        listing: listing.split('\n').filter(Boolean).sort(),
        x,
        y,
        x1,
        y1
      }
    }

    const overRoot = `${REMOTE_DATA}/qa-p103-over-${stamp}`
    await setupRemote(overRoot)
    const over = await uploadDir(overRoot, 'overwrite')
    record(
      'P1-03-overwrite',
      over.state === 'completed' &&
        over.x === 'LOCAL-X-V2' &&
        over.y === 'LOCAL-Y-V2' &&
        over.children.every((target) => !target.includes('(1)')),
      `conflict=${over.conflict} state=${over.state} children=${over.children.length} x=${over.x} y=${over.y}`
    )
    measurements.p103overwrite = over

    const renameRoot = `${REMOTE_DATA}/qa-p103-rename-${stamp}`
    await setupRemote(renameRoot)
    const keep = await uploadDir(renameRoot, 'rename')
    record(
      'P1-03-rename',
      keep.state === 'completed' &&
        keep.listing.includes('x(1).txt') &&
        keep.listing.includes('y(1).txt') &&
        keep.x1 === 'LOCAL-X-V2' &&
        keep.y1 === 'LOCAL-Y-V2' &&
        keep.x === 'REMOTE-X-V1' &&
        keep.y === 'REMOTE-Y-V1',
      `state=${keep.state} listing=${keep.listing.join(',')} x1=${keep.x1} y1=${keep.y1}`
    )
    measurements.p103rename = keep
  }

  if (!ONLY || ONLY === 'p201v2') {
    // ---- QA P2-01v2-1：空目錄上傳（方案 a：不落佇列、直接建遠端目錄） ----
    const stamp = Date.now()
    const localEmpty = path.join(os.tmpdir(), `qa-empty-${stamp}`)
    fs.mkdirSync(localEmpty, { recursive: true })
    const emptyRemote = `${REMOTE_DATA}/qa-empty-${stamp}`

    const before = await remoteExec(sessionId, `test -e ${emptyRemote} && echo EXISTS || echo MISSING`)
    const started = await dispatch(
      CH.transferStart,
      { sessionId, direction: 'upload', items: [{ source: localEmpty, target: emptyRemote }], onConflict: 'overwrite' },
      ctx
    )
    const dirAfter = await remoteExec(sessionId, `test -d ${emptyRemote} && echo DIR || echo MISSING`)
    const rows = started.ok ? started.data : null
    record(
      'P2-01v2-1-empty',
      started.ok && Array.isArray(rows) && rows.length === 0 && before === 'MISSING' && dirAfter === 'DIR',
      `ok=${started.ok} rows=${Array.isArray(rows) ? rows.length : 'err'} before=${before} after=${dirAfter}`
    )
    measurements.p201v2 = { remote: emptyRemote, before, after: dirAfter, rows: Array.isArray(rows) ? rows.length : null }

    const roRoot = `${REMOTE_DATA}/qa-ro-empty-${stamp}`
    await remoteExec(sessionId, `mkdir -p ${roRoot} && chmod 555 ${roRoot}`)
    const denied = await dispatch(
      CH.transferStart,
      {
        sessionId,
        direction: 'upload',
        items: [{ source: localEmpty, target: `${roRoot}/sub` }],
        onConflict: 'overwrite'
      },
      ctx
    )
    record(
      'P2-01v2-1-permission',
      !denied.ok && denied.error.code === 'E_SFTP_PERMISSION',
      `ok=${denied.ok} code=${denied.ok ? '-' : denied.error.code}`
    )
    measurements.p201v2permission = { code: denied.ok ? null : denied.error.code }
    await remoteExec(sessionId, `chmod 755 ${roRoot}`).catch(() => undefined)
  }

  if (!ONLY || ONLY === 'p106') {
    // ---- P1-06：300MB 暫停 → 舊 session 結束 → 用憑證路徑開新 session → 自動續傳 ----
    const bigLocal = path.join(os.tmpdir(), 'qa-p106-300m.bin')
    if (!fs.existsSync(bigLocal) || fs.statSync(bigLocal).size !== 300 * 1024 * 1024) {
      const fd = fs.openSync(bigLocal, 'w')
      const chunk = crypto.randomBytes(1024 * 1024)
      for (let i = 0; i < 300; i++) fs.writeSync(fd, chunk)
      fs.closeSync(fd)
    }
    const remoteBig = `${REMOTE_DATA}/qa-p106-${Date.now()}.bin`
    log(`p106 local=${bigLocal} remote=${remoteBig}`)
    const [task] = await startTransfer({
      sessionId,
      direction: 'upload',
      items: [{ source: bigLocal, target: remoteBig }],
      onConflict: 'overwrite'
    })
    log(`p106 task=${task && task.taskId} session=${task && task.sessionId}`)
    await waitFor(
      async () => {
        const rows = await taskList()
        const row = rows.find((t) => t.taskId === task.taskId)
        return row && row.transferredBytes >= 40 * 1024 * 1024
      },
      180_000,
      'progress >= 40MB'
    )
    await dispatch(CH.transferPause, { taskId: task.taskId }, ctx)
    const paused = await waitFor(
      async () => {
        const rows = await taskList()
        const row = rows.find((t) => t.taskId === task.taskId)
        return row?.state === 'paused' ? row : null
      },
      60_000,
      'paused'
    )
    const pausedAt = paused.transferredBytes
    // 模擬舊 session 結束（憑證重連的真實路徑：舊 session 已 close，見 P1-05）
    ctx.sessions.close(sessionId)
    const resumedSession = await openSession(target.id)
    const finished = await waitTask(task.taskId, 20 * 60 * 1000)
    const remoteSha = await remoteExec(resumedSession.sessionId, `sha256sum ${remoteBig} | cut -d" " -f1`)
    const localSha = sha256(fs.readFileSync(bigLocal))
    const rows = await taskList()
    const oldRefs = rows.filter((row) => row.sessionId === sessionId).length
    const pass =
      pausedAt > 0 &&
      finished.state === 'completed' &&
      remoteSha === localSha &&
      oldRefs === 0 &&
      finished.sessionId === resumedSession.sessionId
    record(
      'P1-06',
      pass,
      `pausedAt=${pausedAt} state=${finished.state} shaMatch=${remoteSha === localSha} oldSessionRefs=${oldRefs} rebound=${finished.sessionId === resumedSession.sessionId}`
    )
    measurements.p106 = {
      pausedAt,
      resumedAt: finished.transferredBytes,
      state: finished.state,
      shaMatch: remoteSha === localSha,
      oldSessionRefs: oldRefs,
      rebound: finished.sessionId === resumedSession.sessionId,
      resumedSessionId: resumedSession.sessionId
    }
    fs.rmSync(bigLocal, { force: true })
    await remoteExec(resumedSession.sessionId, `rm -f ${remoteBig}`).catch(() => undefined)
  }

  fs.writeFileSync(path.join(evidence, 'qa-fix-demo.json'), JSON.stringify({ mode: ONLY || 'all', results, measurements }, null, 2))
  log(`results: ${results.filter((r) => r.pass).length}/${results.length} pass`)
  ctx.sessions.closeAll()
  app.exit(results.every((r) => r.pass) ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('[QA-FIX] ERROR', error && error.stack ? error.stack : error)
    results.push({ id: 'fatal', pass: false, detail: String(error && error.stack ? error.stack : error) })
    fs.writeFileSync(path.join(evidence, 'qa-fix-demo.json'), JSON.stringify({ mode: ONLY || 'all', results, measurements }, null, 2))
    app.exit(1)
  })
)
