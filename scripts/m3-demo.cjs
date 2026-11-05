/**
 * M3 實機 demo（不是產品程式碼）：跳板環境下的 SFTP／傳輸佇列 Gate。
 *   A  100 檔（目錄任務：一列 + children）+ 4GB 混合上傳 → 佇列全綠
 *   A2 同一個 4GB 檔下載回本機 → sha256 相符
 *   B  300MB 上傳中暫停 → 續傳 → 大小／sha256 相符
 *   C  目的主機封包黑洞 → 任務暫停 → [Reconnect Now] → 自動續傳完成
 *   D  本地面板 + 本地↔遠端雙向 + 衝突 skip/rename
 *
 * 前置：spikes/vm/up.js 已起（prod-web-01 有 /srv/data 資料碟）。
 * 用法：M3_ONLY=a|b|c|d 可分段重跑（預設全部）。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const net = require('node:net')
const crypto = require('node:crypto')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'm3-evidence')
const dataDir = path.join(os.tmpdir(), 'remoteshell-m3-demo-' + Date.now())
const localDir = path.join(os.tmpdir(), 'remoteshell-m3-data')
const PASS = 'M0spike!2026'
const REMOTE_ROOT = '/srv/data/m3'

fs.mkdirSync(evidence, { recursive: true })
fs.mkdirSync(localDir, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const measurements = {}
const log = (msg) => console.log(`[M3] ${new Date().toISOString().slice(11, 19)} ${msg}`)
const record = (id, pass, detail) => {
  results.push({ id, pass, detail })
  console.log(`[M3] ${pass ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

let win = null

function buildContext() {
  const { registerIpc } = require(path.join(dist, 'main', 'ipc', 'register.js'))
  const { SettingsStore } = require(path.join(dist, 'main', 'store', 'settings.js'))
  const { ConnectionsStore } = require(path.join(dist, 'main', 'store', 'connections.js'))
  const { VaultService } = require(path.join(dist, 'main', 'vault', 'dpapi.js'))
  const { KnownHostsStore } = require(path.join(dist, 'main', 'transport', 'hostkey.js'))
  const { SessionManager } = require(path.join(dist, 'main', 'ipc', 'handlers', 'session.js'))
  const { SftpRegistry } = require(path.join(dist, 'main', 'sftp', 'registry.js'))
  const { TransferScheduler } = require(path.join(dist, 'main', 'queue', 'scheduler.js'))
  const { createTransferRunner } = require(path.join(dist, 'main', 'ipc', 'handlers', 'transfer.js'))
  const { safeStorage } = require('electron')

  const modules = ['app', 'window', 'settings', 'connections', 'vault', 'session', 'sftp', 'transfer', 'hostkey', 'local'].map(
    (name) => require(path.join(dist, 'main', 'ipc', 'handlers', name + '.js'))
  )

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
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }
  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })
  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({
    maxConcurrent: 3,
    broadcast: (batch) => broadcast('rs:evt:transfer:update', batch),
    runner: createTransferRunner({ sftp, sessions })
  })
  sessions.onStateChange = (info) => {
    if (info.state === 'disconnected' || info.state === 'failed') {
      transfers.pauseSession(info.sessionId)
      sftp.removeBySession(info.sessionId)
    }
  }

  const ctx = {
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
    resolveWindow: () => BrowserWindow.getAllWindows()[0] ?? null
  }
  for (const mod of modules) mod.register()
  registerIpc(ctx)
  return ctx
}

const base = (over) => ({
  groupId: null,
  protocol: 'ssh',
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  ...over
})

async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

/** 截圖：強制把視窗拉到前景並重繪，避免 capturePage 回傳舊的一幀（曾發生三張 MD5 相同） */
async function shot(name) {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  win.moveTop()
  win.webContents.invalidate()
  await sleep(600)
  const image = await win.webContents.capturePage()
  const file = path.join(evidence, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  win.setAlwaysOnTop(false)
  results.push({ id: `screenshot:${name}`, pass: true, detail: file })
  return file
}

function monitor(cmd) {
  return new Promise((resolve) => {
    const socket = net.connect(2512, '127.0.0.1', () => {
      socket.write(cmd + '\n')
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 300)
    })
    socket.on('error', () => resolve())
  })
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  let read = 0
  while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read))
  fs.closeSync(fd)
  return hash.digest('hex')
}

function makeFile(file, sizeBytes, chunk = 4 * 1024 * 1024) {
  if (fs.existsSync(file) && fs.statSync(file).size === sizeBytes) return
  const fd = fs.openSync(file, 'w')
  const buf = Buffer.alloc(chunk)
  let written = 0
  while (written < sizeBytes) {
    const size = Math.min(chunk, sizeBytes - written)
    for (let i = 0; i < size; i += 4096) buf[i] = (written + i) % 251
    fs.writeSync(fd, buf, 0, size)
    written += size
  }
  fs.closeSync(fd)
}

async function remoteExec(ctx, sessionId, command) {
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

async function main() {
  const ctx = buildContext()
  const storedSecret = ctx.vault.encrypt(PASS)

  const jump = ctx.connections.create(
    base({ name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: storedSecret } })
  )
  const target = ctx.connections.create(
    base({
      name: 'prod-web-01',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: storedSecret },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(dist, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'renderer')
  await js(`window.rs.settings.patch({ ui: { queueCollapsed: false, queueHeight: 300 } })`)
  await sleep(600)

  const openSession = async () => {
    const pending = js(
      `window.rs.session.open({ profileId: ${JSON.stringify(target.id)}, cols: 120, rows: 30, ephemeral: { secret: ${JSON.stringify(
        PASS
      )} } }).then(r => r.ok ? r.data.sessionId : 'ERR:' + r.error.code)`
    ).then((value) => ({ value }))
    let outcome = null
    for (let i = 0; i < 600 && !outcome; i++) {
      const modal = await js(`document.querySelector('.rs-modal') ? 'modal' : 'none'`).catch(() => 'none')
      if (modal === 'modal') {
        await js(
          `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Accept and remember')); if(b) b.click() })()`
        )
      }
      outcome = await Promise.race([pending, sleep(100).then(() => null)])
    }
    if (!outcome || String(outcome.value).startsWith('ERR')) throw new Error('open failed ' + (outcome && outcome.value))
    return outcome.value
  }

  let sessionId = await openSession()
  const sftpId = await js(`window.rs.sftp.open(${JSON.stringify(sessionId)}).then(r => r.ok ? r.data.sftpId : 'ERR')`)
  log(`session=${sessionId} sftp=${sftpId}`)
  await remoteExec(ctx, sessionId, `mkdir -p ${REMOTE_ROOT}/big ${REMOTE_ROOT}/many ${REMOTE_ROOT}/conflict && df -h /srv/data | tail -1`).then(
    (out) => log(`remote storage: ${out}`)
  )

  const allTasks = () =>
    js(`window.rs.transfer.list().then(r => r.ok ? JSON.stringify(r.data) : '[]')`).then((raw) => JSON.parse(raw))
  const rowsOnly = (tasks) => tasks.filter((t) => !t.parentId)
  const allDone = (tasks) => rowsOnly(tasks).every((t) => t.state === 'completed') && rowsOnly(tasks).length > 0

  const ONLY = (process.env.M3_ONLY || 'abcd').toLowerCase()
  const want = (k) => ONLY.includes(k)
  const dropSize = Number(process.env.M3_C_SIZE || 300) * 1024 * 1024

  /* ---------------- A：100 檔（目錄任務）+ 4GB ---------------- */
  if (want('a')) {
    const manyDir = path.join(localDir, 'many')
    fs.mkdirSync(manyDir, { recursive: true })
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(manyDir, `檔案_${String(i).padStart(3, '0')}.txt`), `file ${i} 中文內容\n`.repeat(20 + i))
    }
    const bigLocal = path.join(localDir, 'big4g.bin')
    log('建立 4GB 測資…')
    makeFile(bigLocal, 4 * 1024 * 1024 * 1024)
    const bigHash = sha256File(bigLocal)

    await remoteExec(ctx, sessionId, `rm -rf ${REMOTE_ROOT}/many/* ${REMOTE_ROOT}/big/big4g.bin`)
    const startedAt = Date.now()
    const started = JSON.parse(
      await js(
        `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'upload', onConflict: 'overwrite', items: [
          { source: ${JSON.stringify(manyDir)}, target: ${JSON.stringify(REMOTE_ROOT + '/many')} },
          { source: ${JSON.stringify(bigLocal)}, target: ${JSON.stringify(REMOTE_ROOT + '/big/big4g.bin')} }
        ] }).then(r => r.ok ? JSON.stringify(r.data) : 'ERR:' + r.error.code)`
      )
    )
    log(`queue 收到 ${started.length} 列（目錄任務 1 + 4GB 1）`)

    let lastLog = 0
    await waitFor(
      async () => {
        const tasks = await allTasks()
        const failed = rowsOnly(tasks).filter((t) => t.state === 'failed')
        if (failed.length > 0) throw new Error('transfer failed: ' + JSON.stringify(failed[0].error))
        if (Date.now() - lastLog > 60000) {
          const big = rowsOnly(tasks).find((t) => t.source.endsWith('big4g.bin'))
          const dir = rowsOnly(tasks).find((t) => t.isDirectory)
          log(
            `進度：4GB ${(big ? big.transferredBytes / 1024 / 1024 : 0).toFixed(0)}MB @ ${(big ? big.bytesPerSec / 1024 / 1024 : 0).toFixed(2)}MB/s；目錄 ${dir ? dir.children?.filter((c) => c.state === 'completed').length : 0}/100`
          )
          lastLog = Date.now()
        }
        return allDone(tasks)
      },
      60 * 60 * 1000,
      'A 完成'
    )
    const durationMs = Date.now() - startedAt
    const shotA = await shot('m3-01-queue-green')

    const remoteBig = await js(
      `window.rs.sftp.list(${JSON.stringify(sftpId)}, ${JSON.stringify(REMOTE_ROOT + '/big')}).then(r => r.ok ? JSON.stringify(r.data.entries.find(e => e.name === 'big4g.bin')) : 'null')`
    )
    const remoteCount = await remoteExec(ctx, sessionId, `ls -1 ${REMOTE_ROOT}/many | wc -l`)
    const remoteBigHash = await remoteExec(ctx, sessionId, `sha256sum ${REMOTE_ROOT}/big/big4g.bin | cut -d' ' -f1`)
    const parentRow = rowsOnly(await allTasks()).find((t) => t.isDirectory)
    measurements.upload = {
      durationMs,
      dirTaskId: parentRow ? parentRow.taskId : null,
      dirChildren: parentRow ? parentRow.children.length : 0,
      dirState: parentRow ? parentRow.state : null,
      bigBytes: remoteBig ? Number(JSON.parse(remoteBig).size) : null,
      remoteFileCount: Number(remoteCount),
      sha256Local: bigHash,
      sha256Remote: remoteBigHash,
      screenshot: shotA
    }
    record(
      'M3-1 100 檔（目錄任務）+ 4GB 混合上傳',
      Number(remoteCount) === 100 &&
        measurements.upload.bigBytes === 4 * 1024 * 1024 * 1024 &&
        remoteBigHash === bigHash &&
        parentRow !== undefined &&
        parentRow.children.length === 100 &&
        parentRow.state === 'completed',
      `${durationMs}ms；目錄列 children=${parentRow ? parentRow.children.length : 0}（completed）＋4GB ${measurements.upload.bigBytes} bytes、sha256 相符=${remoteBigHash === bigHash}`
    )

    /* ------------- A2：4GB 下載 ------------- */
    const bigDown = path.join(localDir, 'big4g-down.bin')
    if (fs.existsSync(bigDown)) fs.rmSync(bigDown, { force: true })
    const dlStart = Date.now()
    await js(
      `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'download', onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
        REMOTE_ROOT + '/big/big4g.bin'
      )}, target: ${JSON.stringify(bigDown)} }] }).then(r => r.ok ? 'ok' : 'ERR:' + r.error.code)`
    )
    await waitFor(
      async () => {
        const tasks = allTasks.length >= 0 ? rowsOnly(await allTasks()) : []
        const task = tasks.find((t) => t.direction === 'download' && !t.isDirectory)
        if (!task) return false
        if (task.state === 'failed') throw new Error('download failed: ' + JSON.stringify(task.error))
        return task.state === 'completed'
      },
      60 * 60 * 1000,
      'A2 完成'
    )
    const dlMs = Date.now() - dlStart
    const dlHash = sha256File(bigDown)
    const shotD = await shot('m3-04-download-4g')
    measurements.download = { durationMs: dlMs, bytes: fs.statSync(bigDown).size, sha256: dlHash, matches: dlHash === bigHash, screenshot: shotD }
    record(
      'M3-1b 4GB 下載',
      fs.statSync(bigDown).size === 4 * 1024 * 1024 * 1024 && dlHash === bigHash,
      `${dlMs}ms；bytes=${measurements.download.bytes}；sha256 相符=${dlHash === bigHash}`
    )
  }

  /* ---------------- B：暫停／續傳 ---------------- */
  if (want('b')) {
    const resumeLocal = path.join(localDir, 'resume300.bin')
    makeFile(resumeLocal, 300 * 1024 * 1024)
    const resumeHash = sha256File(resumeLocal)
    const resumeTarget = `${REMOTE_ROOT}/big/resume300.bin`
    await remoteExec(ctx, sessionId, `rm -f ${resumeTarget}`)

    const [resumeTask] = JSON.parse(
      await js(
        `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'upload', onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
          resumeLocal
        )}, target: ${JSON.stringify(resumeTarget)} }] }).then(r => r.ok ? JSON.stringify(r.data) : 'ERR')`
      )
    )
    await waitFor(async () => {
      const task = rowsOnly(await allTasks()).find((t) => t.taskId === resumeTask.taskId)
      return task && task.transferredBytes > 40 * 1024 * 1024
    }, 600000, 'B 傳到 40MB')

    await js(`window.rs.transfer.pause(${JSON.stringify(resumeTask.taskId)})`)
    await waitFor(async () => {
      const task = rowsOnly(await allTasks()).find((t) => t.taskId === resumeTask.taskId)
      return task?.state === 'paused'
    }, 30000, 'B paused')
    const pausedTask = rowsOnly(await allTasks()).find((t) => t.taskId === resumeTask.taskId)
    const partialSize = pausedTask ? pausedTask.transferredBytes : 0

    await js(`window.rs.transfer.resume(${JSON.stringify(resumeTask.taskId)})`)
    await waitFor(async () => {
      const task = rowsOnly(await allTasks()).find((t) => t.taskId === resumeTask.taskId)
      return task?.state === 'completed'
    }, 900000, 'B 續傳完成')
    const finalHash = await remoteExec(ctx, sessionId, `sha256sum ${resumeTarget} | cut -d' ' -f1`)
    const finalSize = await remoteExec(ctx, sessionId, `stat -c %s ${resumeTarget}`)
    const shotB = await shot('m3-02-resume')
    measurements.resume = {
      pausedAtBytes: partialSize,
      finalBytes: Number(finalSize),
      sha256Matches: finalHash === resumeHash,
      screenshot: shotB
    }
    record(
      'M3-2 暫停／續傳（300MB）',
      partialSize > 0 && partialSize < 300 * 1024 * 1024 && Number(finalSize) === 300 * 1024 * 1024 && finalHash === resumeHash,
      `暫停點 ${partialSize} bytes → 完成 ${finalSize} bytes、sha256 相符=${finalHash === resumeHash}`
    )
  }

  /* ---------------- C：斷線 → 暫停 → 重連續傳 ---------------- */
  if (want('c')) {
    const dropLocal = path.join(localDir, 'drop300.bin')
    makeFile(dropLocal, dropSize)
    const dropTarget = `${REMOTE_ROOT}/big/drop300.bin`
    await remoteExec(ctx, sessionId, `rm -f ${dropTarget}`)
    const [dropTask] = JSON.parse(
      await js(
        `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'upload', onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
          dropLocal
        )}, target: ${JSON.stringify(dropTarget)} }] }).then(r => r.ok ? JSON.stringify(r.data) : 'ERR')`
      )
    )
    await waitFor(async () => {
      const task = rowsOnly(await allTasks()).find((t) => t.taskId === dropTask.taskId)
      return (task?.transferredBytes ?? 0) > 20 * 1024 * 1024
    }, 600000, 'C 傳到 20MB')

    const frozenAt = Date.now()
    await monitor('stop')
    await waitFor(async () => {
      const task = rowsOnly(await allTasks()).find((t) => t.taskId === dropTask.taskId)
      return task?.state === 'paused'
    }, 60000, 'C 斷線後 paused')
    const detectMs = Date.now() - frozenAt
    await monitor('cont')
    await sleep(1000)

    const oldSessionId = sessionId
    const clicked = await js(
      `(() => { const b=[...document.querySelectorAll('.rs-statusbar button')].find(x=>(x.textContent||'').includes('Reconnect')); if(b){b.click();return true} return false })()`
    )
    let reopened = ''
    if (clicked) {
      reopened = await waitFor(async () => {
        const task = rowsOnly(await allTasks()).find((t) => t.taskId === dropTask.taskId)
        return task && task.sessionId !== oldSessionId ? task.sessionId : null
      }, 60000, 'C 任務改綁新 session')
    } else {
      reopened = await js(
        `window.rs.session.reconnect(${JSON.stringify(oldSessionId)}).then(r => r.ok ? r.data.sessionId : 'ERR')`
      )
    }
    sessionId = reopened
    await waitFor(async () => {
      const task = rowsOnly(await allTasks()).find((t) => t.taskId === dropTask.taskId)
      if (task?.state === 'failed') throw new Error('resume failed: ' + JSON.stringify(task.error))
      return task?.state === 'completed'
    }, 900000, 'C 重連後續傳完成')
    const dropSizeOnRemote = await remoteExec(ctx, sessionId, `stat -c %s ${dropTarget}`)
    const shotC = await shot('m3-03-reconnect')
    measurements.reconnect = {
      detectMs,
      clickedReconnect: clicked,
      newSessionId: reopened,
      finalBytes: Number(dropSizeOnRemote),
      screenshot: shotC
    }
    record(
      'M3-3 斷線暫停 + 重連續傳',
      detectMs <= 35000 && Number(dropSizeOnRemote) === dropSize,
      `偵測 ${detectMs}ms；[Reconnect Now]=${clicked}；重連後完成 ${dropSizeOnRemote} bytes`
    )
  }

  /* ---------------- D：本地面板 + 雙向 + 衝突 ---------------- */
  if (want('d')) {
    const localHome = await js(`window.rs.localFs.home().then(r => r.ok ? r.data : 'ERR:' + r.error.code)`)
    const homeList = JSON.parse(
      await js(
        `window.rs.localFs.list(${JSON.stringify(localHome)}).then(r => r.ok ? JSON.stringify({ count: r.data.entries.length, drives: r.data.drives }) : '{"count":-1,"drives":[]}')`
      )
    )
    measurements.localPanel = { home: localHome, entries: homeList.count, drives: homeList.drives }
    record(
      'M3-4 本地面板（home/list/drives）',
      typeof localHome === 'string' && homeList.count >= 0 && homeList.drives.length > 0,
      `home=${localHome}；entries=${homeList.count}；drives=${homeList.drives.join(',')}`
    )

    const sandbox = path.join(localDir, 'local-panel')
    if (fs.existsSync(sandbox)) fs.rmSync(sandbox, { recursive: true, force: true })
    const mk = await js(`window.rs.localFs.mkdir(${JSON.stringify(sandbox)}).then(r => r.ok)`)
    const renamed = await js(
      `window.rs.localFs.rename(${JSON.stringify(sandbox)}, ${JSON.stringify(sandbox + '-2')}).then(r => r.ok)`
    )
    const removed = await js(`window.rs.localFs.remove(${JSON.stringify(sandbox + '-2')}, true).then(r => r.ok)`)
    const traversal = await js(
      `window.rs.localFs.list(${JSON.stringify(sandbox + '\\\\..\\\\..\\\\Windows')}).then(r => r.ok ? 'ALLOWED' : r.error.code)`
    )
    record(
      'M3-4 本地 mkdir/rename/remove + 路徑逃逸防護',
      mk === true && renamed === true && removed === true && traversal === 'E_LOCAL_IO',
      `mkdir=${mk} rename=${renamed} remove=${removed}；逃逸 → ${traversal}`
    )

    const upDir = path.join(localDir, 'panel-up')
    const downDir = path.join(localDir, 'panel-down')
    fs.mkdirSync(upDir, { recursive: true })
    if (fs.existsSync(downDir)) fs.rmSync(downDir, { recursive: true, force: true })
    fs.mkdirSync(downDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(upDir, `本地檔案_${i}.txt`), `local→remote ${i} 中文內容\n`.repeat(50))
    }
    const remotePanel = `${REMOTE_ROOT}/panel`
    await remoteExec(ctx, sessionId, `mkdir -p ${remotePanel} && rm -rf ${remotePanel}/*`)

    await js(
      `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'upload', onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
        upDir
      )}, target: ${JSON.stringify(remotePanel)} }] }).then(r => r.ok ? 'ok' : 'ERR')`
    )
    await waitFor(async () => {
      const rows = rowsOnly(await allTasks())
      const row = rows.find((t) => t.target === remotePanel && t.isDirectory)
      return row && row.state === 'completed'
    }, 300000, 'D 上傳完成')

    await js(
      `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'download', onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
        remotePanel
      )}, target: ${JSON.stringify(downDir)} }] }).then(r => r.ok ? 'ok' : 'ERR')`
    )
    await waitFor(async () => {
      const rows = rowsOnly(await allTasks())
      const row = rows.find((t) => t.direction === 'download' && t.isDirectory && t.source === remotePanel)
      return row && row.state === 'completed'
    }, 300000, 'D 下載完成')

    const upFiles = fs.readdirSync(upDir).sort()
    const downFiles = fs.readdirSync(downDir).sort()
    const sameContent =
      upFiles.length === 5 &&
      JSON.stringify(upFiles) === JSON.stringify(downFiles) &&
      upFiles.every((name) => sha256File(path.join(upDir, name)) === sha256File(path.join(downDir, name)))
    const shotD2 = await shot('m3-05-local-panel')
    record('M3-4 本地↔遠端雙向（5 檔內容比對）', sameContent, `上傳 ${upFiles.length} / 下載 ${downFiles.length}；內容一致=${sameContent}`)

    // 衝突：同一批再上傳一次，skip 應跳過、rename 應產生 file(1)
    const conflictFile = path.join(upDir, '本地檔案_0.txt')
    const conflictTarget = `${remotePanel}/本地檔案_0.txt`
    const skipResult = JSON.parse(
      await js(
        `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'upload', onConflict: 'skip', items: [{ source: ${JSON.stringify(
          conflictFile
        )}, target: ${JSON.stringify(conflictTarget)} }] }).then(r => r.ok ? JSON.stringify(r.data) : 'ERR')`
      )
    )
    const renameResult = JSON.parse(
      await js(
        `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: 'upload', onConflict: 'rename', items: [{ source: ${JSON.stringify(
          conflictFile
        )}, target: ${JSON.stringify(conflictTarget)} }] }).then(r => r.ok ? JSON.stringify(r.data) : 'ERR')`
      )
    )
    await waitFor(async () => {
      const rows = rowsOnly(await allTasks())
      const renameRow = rows.find((t) => t.target.includes('本地檔案_0(1).txt'))
      return renameRow && renameRow.state === 'completed'
    }, 60000, 'D rename 完成')
    const conflictList = await remoteExec(ctx, sessionId, `ls -1 ${remotePanel} | sort | tr '\\n' ' '`)
    record(
      'M3-6 衝突 skip / rename',
      Array.isArray(skipResult) &&
        skipResult.length === 0 &&
        Array.isArray(renameResult) &&
        renameResult[0] &&
        String(renameResult[0].target).includes('本地檔案_0(1).txt') &&
        conflictList.includes('本地檔案_0(1).txt'),
      `skip 產生 ${Array.isArray(skipResult) ? skipResult.length : '?'} 筆任務；rename 目標 ${Array.isArray(renameResult) && renameResult[0] ? renameResult[0].target : 'n/a'}`
    )
    measurements.localPanel.download = { files: downFiles.length }
    measurements.localPanel.conflict = { skipTasks: skipResult.length, renameTarget: renameResult[0]?.target, remoteListing: conflictList }
    void shotD2
  }

  const summary = {
    electron: process.versions.electron,
    dataDir,
    finishedAt: new Date().toISOString(),
    mode: ONLY,
    measurements,
    results: results.filter((r) => !String(r.id).startsWith('screenshot:'))
  }
  fs.writeFileSync(path.join(evidence, 'm3-demo.json'), JSON.stringify(summary, null, 2))
  process.stdout.write('M3_DEMO ' + JSON.stringify({ ok: summary.results.every((r) => r.pass), results: summary.results }) + '\n')
  app.exit(summary.results.every((r) => r.pass) ? 0 : 1)
}

app.whenReady().then(main).catch(async (error) => {
  await monitor('cont').catch(() => undefined)
  process.stdout.write(
    'M3_DEMO ' + JSON.stringify({ ok: false, error: String((error && error.stack) || error) }) + '\n'
  )
  app.exit(1)
})
