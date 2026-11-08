import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { candidateHosts, checkChromeCookies, chromeKey, readChromeCookies, toElectronCookie } from './chrome-cookies'
import http from 'node:http'
import path from 'node:path'

/**
 * 데스크톱 셸 (PoC)
 *  - 왼쪽: 에이전트 UI (개발 중에는 Vite 서버, 서버 주소는 AGENT_UI_URL)
 *  - 오른쪽: 에이전트가 조작하는 내장 브라우저 (WebContentsView, 전용 세션)
 *  - 백엔드는 127.0.0.1 의 CDP 포트로 내장 브라우저에 붙어 자동화한다 (connect_over_cdp)
 */
const UI_URL = process.env.AGENT_UI_URL ?? 'http://localhost:5173'
const SERVER_URL = process.env.AGENT_SERVER_URL ?? '' // 비우면 UI 와 같은 출처(상대 경로)
const CDP_PORT = Number(process.env.AGENT_CDP_PORT ?? 9222)
// 시작 페이지: 빈 화면(about:blank) 대신 안내와 주소 입력란을 보여 준다 (아직 주소창 UI 가 없다)
const START_HTML = `<!doctype html><meta charset="utf-8"><title>에이전트 브라우저</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:15px -apple-system,BlinkMacSystemFont,sans-serif;background:#f7f8fa;color:#333}
.box{width:min(520px,86vw);text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#777;margin:0 0 20px;line-height:1.6}
form{display:flex;gap:8px}input{flex:1;padding:11px 14px;border:1px solid #d0d5dd;border-radius:10px;font-size:14px;outline:none}
input:focus{border-color:#4f6bed}button{padding:0 18px;border:0;border-radius:10px;background:#4f6bed;color:#fff;font-size:14px;cursor:pointer}
</style><div class="box"><h1>에이전트 브라우저</h1><p>에이전트가 웹 작업을 할 때 이 화면에서 실행됩니다.<br>직접 사이트를 열어 로그인해 두면 이후 작업에서도 유지됩니다.</p>
<form onsubmit="var v=this.u.value.trim();if(!v)return false;if(!/^https?:\/\//i.test(v))v='https://'+v;location.href=v;return false">
<input name="u" placeholder="주소를 입력하세요 (예: naver.com)" autofocus><button>이동</button></form></div>`
const START_PAGE = process.env.AGENT_START_PAGE ?? 'data:text/html;charset=utf-8,' + encodeURIComponent(START_HTML)

// 같은 PC 의 백엔드만 붙을 수 있게 로컬에만 연다. (정식 버전은 토큰으로 보호되는 브리지로 교체 예정)
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT))
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

let win: BrowserWindow | null = null
let uiView: WebContentsView | null = null
let bannerView: WebContentsView | null = null
let toolbarView: WebContentsView | null = null
let browserView: WebContentsView | null = null
let split = 0.6 // UI 가 차지하는 가로 비율 (채팅 화면이 좁으면 레이아웃이 깨지므로 UI 쪽을 더 넓게 둔다)
// 브라우저 영역은 평소에 접어 두고(UI 가 창 전체를 씀), 에이전트가 쓰기 시작하면 자동으로 펼치고 쓰지 않으면 다시 접는다.
// 사용자가 Cmd+B 로 직접 연 경우(pinned)는 자동으로 접지 않는다. AGENT_BROWSER_AUTOHIDE=0 이면 항상 펼쳐 둔다.
const AUTO_HIDE = process.env.AGENT_BROWSER_AUTOHIDE !== '0'
const HIDE_IDLE_MS = 10000
let browserHidden = AUTO_HIDE
let pinned = false // 사용자가 직접 펼침
let autoShown = false // 에이전트 때문에 자동으로 펼침

// 에이전트 조작 상태: 백엔드가 명령을 보낼 때마다 /activity 로 알려 주고, 사용자가 '중지'를 누르면 stopRequested 가 켜진다
const BANNER_H = 36
const ACTIVE_MS = 6000
let lastActivity = 0
let stopRequested = false
let attention = '' // 사용자가 직접 해야 할 일(로그인·CAPTCHA) 안내 문구. 비어 있지 않으면 배너를 계속 보여 준다
let bannerShown = false
const agentActive = () => attention !== '' || Date.now() - lastActivity < ACTIVE_MS

function refreshBanner() {
  const text = attention || '에이전트가 이 브라우저를 조작 중입니다'
  bannerView?.webContents.executeJavaScript(`setBanner(${JSON.stringify(text)}, ${attention === ''})`).catch(() => {})
}

const BANNER_HTML = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;height:${BANNER_H}px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;box-sizing:border-box;
font:13px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff4e5;color:#7a4100;border-bottom:1px solid #f5c98a;user-select:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f97316;margin-right:8px;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.3}}button{border:0;border-radius:6px;padding:5px 12px;background:#d93025;color:#fff;font-size:12px;font-weight:600;cursor:pointer}
</style><body><span id="t"><i class="dot"></i>에이전트가 이 브라우저를 조작 중입니다</span><button id="b" onclick="banner.stop()">중지</button>
<script>function setBanner(text,showStop){document.getElementById('t').innerHTML='<i class="dot"></i>';document.getElementById('t').appendChild(document.createTextNode(text));document.getElementById('b').style.display=showStop?'':'none'}</script></body>`

// 데스크톱 사이트는 보통 1000~1280px 이상을 전제로 만들어져 있어, 우측 영역(창의 40%)에 그대로 넣으면 가로가 잘린다.
// 영역 너비가 FIT_WIDTH 보다 좁으면 페이지 배율을 줄여 '페이지 전체 너비'가 영역에 맞게 보이도록 한다.
const FIT_WIDTH = 1280
const MIN_FIT_ZOOM = 0.4
let userZoom = 1 // '맞춤' 배율에 곱하는 사용자 조절 값 (확대/축소 버튼)
function fitZoom() {
  if (!win || !browserView || browserView.webContents.isDestroyed()) return
  const paneW = win.getContentBounds().width - Math.round(win.getContentBounds().width * split)
  const fit = Math.max(MIN_FIT_ZOOM, Math.min(1, paneW / FIT_WIDTH))
  const z = Math.max(0.25, Math.min(3, fit * userZoom))
  if (Math.abs(browserView.webContents.getZoomFactor() - z) > 0.01) browserView.webContents.setZoomFactor(z)
  toolbarView?.webContents.executeJavaScript(`setPct(${Math.round(z * 100)})`).catch(() => {})
}
function stepZoom(dir: 'in' | 'out' | 'fit') {
  userZoom = dir === 'fit' ? 1 : Math.max(0.3, Math.min(4, userZoom * (dir === 'in' ? 1.2 : 1 / 1.2)))
  fitZoom()
}
ipcMain.on('browser:zoom', (_e, dir: 'in' | 'out' | 'fit') => stepZoom(dir))

const TOOLBAR_H = 30
const TOOLBAR_HTML = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;height:${TOOLBAR_H}px;display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:0 8px;box-sizing:border-box;
font:12px -apple-system,BlinkMacSystemFont,sans-serif;background:#f3f4f6;color:#374151;border-bottom:1px solid #e5e7eb;user-select:none}
button{border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#374151;height:22px;min-width:26px;font-size:14px;line-height:1;cursor:pointer;padding:0 6px}
button:hover{background:#eef0f3}#p{min-width:46px;font-size:12px}</style><body>
<button title="축소 (Cmd -)" onclick="banner.zoom('out')">−</button>
<button id="p" title="화면에 맞춤으로 되돌리기" onclick="banner.zoom('fit')">100%</button>
<button title="확대 (Cmd +)" onclick="banner.zoom('in')">+</button>
<script>function setPct(n){document.getElementById('p').textContent=n+'%'}</script></body>`

function layout() {
  if (!win || !uiView || !browserView) return
  const { width, height } = win.getContentBounds()
  const paneW = width - Math.round(width * split)
  const uiW = browserHidden ? width : width - paneW
  uiView.setBounds({ x: 0, y: 0, width: uiW, height })
  const top = (bannerShown ? BANNER_H : 0) + TOOLBAR_H
  toolbarView?.setBounds({ x: browserHidden ? width : uiW, y: bannerShown ? BANNER_H : 0, width: paneW, height: TOOLBAR_H })
  const showBanner = bannerShown && !browserHidden
  bannerView?.setBounds({ x: uiW, y: 0, width: paneW, height: showBanner ? BANNER_H : 0 })
  bannerView?.setVisible(showBanner)
  // 접힌 상태에서도 CDP 조작(클릭 좌표·스크린샷)이 되도록 같은 크기로 유지하되 창 밖(오른쪽)으로 밀어 둔다.
  // 크기를 0 으로 줄이면 페이지의 viewport 가 0 이 되어 조작이 깨진다.
  browserView.setBounds({ x: browserHidden ? width : uiW, y: top, width: paneW, height: height - top })
  fitZoom()
}

/** 에이전트가 브라우저를 쓰기 시작할 때 접혀 있으면 자동으로 펼친다 */
function autoShow() {
  if (!browserHidden) return
  browserHidden = false
  autoShown = !pinned
  layout()
}

function create() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    title: 'AI Agent',
  })

  // 에이전트 UI (창 전체가 아니라 왼쪽 영역만 차지하도록 View 로 만든다)
  uiView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.contentView.addChildView(uiView)
  uiView.webContents.loadURL(UI_URL)

  // 내장 브라우저: 앱 UI 와 쿠키를 분리한 전용 파티션 (영구 저장)
  const ses = session.fromPartition('persist:agent-browser')
  // UA 에서 Electron 표식을 제거한다 (일부 사이트가 임베디드 브라우저를 막는다)
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sai-agent-desktop\/\S+/, ''))

  browserView = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(browserView)
  browserView.webContents.loadURL(START_PAGE)
  // 페이지 이동 시 배율이 사이트별 값으로 바뀔 수 있어 다시 맞춘다
  browserView.webContents.on('dom-ready', fitZoom)
  browserView.webContents.on('did-navigate', fitZoom)
  // 새 창 요청은 같은 뷰에서 연다 (탭 UI 는 이후 단계)
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    browserView?.webContents.loadURL(url)
    return { action: 'deny' }
  })

  bannerView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'banner-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(bannerView)
  bannerView.setVisible(false)
  toolbarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'banner-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(toolbarView)
  toolbarView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOOLBAR_HTML))
  toolbarView.webContents.on('did-finish-load', fitZoom)
  bannerView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BANNER_HTML))
  setInterval(() => {
    const show = agentActive()
    if (show !== bannerShown) { bannerShown = show; refreshBanner(); layout() }
    // 에이전트가 한동안 쓰지 않으면 자동으로 접는다 (사용자가 직접 펼친 경우는 제외)
    if (autoShown && !pinned && !browserHidden && attention === '' && Date.now() - lastActivity > HIDE_IDLE_MS) {
      browserHidden = true
      autoShown = false
      layout()
    }
  }, 1000)

  win.on('resize', layout)
  layout()
  win.on('closed', () => { win = null; uiView = null; bannerView = null; toolbarView = null; browserView = null })
}

/**
 * 백엔드가 UI 창과 내장 브라우저를 구분할 수 있게, 내장 브라우저의 CDP targetId 를 알려 주는 로컬 전용 info 서버.
 * (CDP 의 /json 목록에는 어느 페이지가 에이전트 브라우저인지 표시가 없다)  포트는 CDP 포트 + 1, 127.0.0.1 에만 바인드.
 */
async function browserTargetId(): Promise<string | null> {
  const wc = browserView?.webContents
  if (!wc) return null
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    const r = await wc.debugger.sendCommand('Target.getTargetInfo')
    return r?.targetInfo?.targetId ?? null
  } catch {
    return null
  }
}

function startInfoServer() {
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/activity') {
      // 백엔드가 명령을 보낼 때마다 호출: 조작 중 표시를 갱신하고, 사용자가 누른 '중지'를 한 번만 전달한다
      const stop = stopRequested
      stopRequested = false
      let opened = false // 이번 호출로 접혀 있던 브라우저가 펼쳐졌는가 (펼쳐진 직후엔 크기가 잡힐 때까지 잠깐 기다려야 한다)
      if (!stop) {
        opened = browserHidden
        autoShow()
        lastActivity = Date.now()
        if (!bannerShown) { bannerShown = true; refreshBanner(); layout() }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ stop, opened }))
      return
    }
    if (req.method === 'POST' && req.url === '/attention') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
      req.on('end', () => {
        try { attention = String(JSON.parse(body || '{}').message ?? '').slice(0, 200) } catch { attention = '' }
        if (attention) { autoShow(); lastActivity = Date.now(); bannerShown = true; browserView?.webContents.focus() } else { lastActivity = 0 }
        refreshBanner()
        layout()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    if (req.url === '/agent-browser') {
      const targetId = await browserTargetId()
      res.writeHead(targetId ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(targetId ? { targetId } : { error: 'browser not ready' }))
      return
    }
    res.writeHead(404).end()
  })
  srv.listen(CDP_PORT + 1, '127.0.0.1')
}

/**
 * 로컬 Chrome 의 로그인 쿠키 가져오기 (macOS).
 * 에이전트가 로그인을 요청했을 때 사용자가 UI 의 버튼으로 시작하고, 현재 에이전트 브라우저가 열고 있는 사이트의 쿠키만 대상이다.
 * 쿠키 값은 main 프로세스 안에서만 다루며 UI·서버·AI 로는 개수만 돌려준다. 가져오기 전에 네이티브 확인창으로 한 번 더 확인한다.
 */
function assertUiSender(e: IpcMainInvokeEvent) {
  if (!uiView || e.sender !== uiView.webContents) throw new Error('허용되지 않은 호출입니다')
}
const siteOf = (url: string) => candidateHosts(url)[0] ?? ''

ipcMain.handle('chrome:check', async (e) => {
  assertUiSender(e)
  if (process.platform !== 'darwin') return { error: 'unsupported' }
  const url = browserView?.webContents.getURL() ?? ''
  const site = siteOf(url)
  if (!site) return { error: 'no-site' }
  try {
    const r = await checkChromeCookies(url)
    return r ? { site, profile: r.profile, count: r.count } : { error: 'no-site' }
  } catch {
    return { site, error: 'chrome-not-found' }
  }
})

ipcMain.handle('chrome:import', async (e) => {
  assertUiSender(e)
  if (process.platform !== 'darwin' || !win || !browserView) return { error: 'unsupported' }
  const url = browserView.webContents.getURL()
  const site = siteOf(url)
  if (!site) return { error: 'no-site' }
  const check = await checkChromeCookies(url).catch(() => null)
  if (!check || check.count === 0) return { site, error: 'no-cookies' }

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['가져오기', '취소'],
    defaultId: 1,
    cancelId: 1,
    message: `Chrome 에 저장된 ${site} 의 로그인 쿠키 ${check.count}개를 에이전트 브라우저로 복사할까요?`,
    detail: '복사한 쿠키로 에이전트 브라우저가 이 사이트에 로그인된 상태가 됩니다. macOS 가 Chrome 키체인 접근 허용을 물을 수 있습니다. 쿠키 값은 이 앱 안에서만 사용되고 서버나 AI 에는 전달되지 않습니다.',
  })
  if (response !== 0) return { site, error: 'cancelled' }

  let key: Buffer
  try {
    key = await chromeKey()
  } catch {
    return { site, error: 'keychain-denied' }
  }
  const { cookies, skipped } = await readChromeCookies(url, key)
  const ses = browserView.webContents.session
  let imported = 0
  let failed = 0
  for (const c of cookies) {
    try {
      await ses.cookies.set(toElectronCookie(c))
      imported++
    } catch {
      failed++
    }
  }
  await ses.cookies.flushStore()
  if (imported > 0) browserView.webContents.reload() // 로그인된 상태로 다시 불러온다
  return { site, imported, skipped, failed }
})

ipcMain.on('agent:stop', () => {
  stopRequested = true
  lastActivity = 0 // 배너는 바로 숨긴다. 백엔드가 다음 명령에서 중지를 확인한다
  bannerShown = false
  layout()
})
ipcMain.handle('desktop:info', () => ({
  serverUrl: SERVER_URL,
  cdpPort: CDP_PORT,
  platform: process.platform,
}))
ipcMain.handle('browser:navigate', (_e, url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 열 수 있습니다')
  return browserView?.webContents.loadURL(url)
})
ipcMain.handle('browser:set-split', (_e, ratio: number) => {
  split = Math.min(0.8, Math.max(0.2, ratio))
  browserHidden = false
  pinned = true
  layout()
})

function buildMenu() {
  const setSplit = (r: number) => () => { browserHidden = false; pinned = true; split = r; layout() }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: '보기',
      submenu: [
        {
        label: '브라우저 영역 접기/펴기',
        accelerator: 'CmdOrCtrl+B',
        click: () => {
          browserHidden = !browserHidden
          pinned = !browserHidden // 직접 펼친 경우만 고정, 접으면 해제
          autoShown = false
          layout()
        },
      },
        { type: 'separator' },
        { label: '브라우저 좁게 (UI 70%)', accelerator: 'CmdOrCtrl+Alt+1', click: setSplit(0.7) },
        { label: '브라우저 보통 (UI 60%)', accelerator: 'CmdOrCtrl+Alt+2', click: setSplit(0.6) },
        { label: '브라우저 넓게 (UI 40%)', accelerator: 'CmdOrCtrl+Alt+3', click: setSplit(0.4) },
        { type: 'separator' },
        { label: '브라우저 확대', accelerator: 'CmdOrCtrl+Plus', click: () => stepZoom('in') },
        { label: '브라우저 축소', accelerator: 'CmdOrCtrl+-', click: () => stepZoom('out') },
        { label: '브라우저 화면에 맞춤', accelerator: 'CmdOrCtrl+0', click: () => stepZoom('fit') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]))
}

app.whenReady().then(() => {
  buildMenu()
  create()
  startInfoServer()
  console.log(`[desktop] UI=${UI_URL} CDP=http://127.0.0.1:${CDP_PORT}`)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) create() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
