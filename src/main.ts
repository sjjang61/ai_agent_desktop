import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeTheme, screen, session, shell } from 'electron'
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
// ── 테마: 에이전트 UI(왼쪽)의 라이트/다크 설정을 따라간다. 모든 자체 화면은 아래 CSS 변수만 쓴다 ──
const THEME_CSS = `:root{--bg:#f7f8fa;--bar:#eef0f3;--bar2:#fff;--tab:#e1e4e9;--tab-on:#fff;--field:#f1f3f5;--field-on:#fff;--text:#1a1a1a;--text2:#495057;--muted:#868e96;--border:#e1e4e8;--hover:#e9ecef;--card:#fff;--thumb:#f3f4f6;--accent:#3b82f6;--line:#d1d5db;--warn-bg:#fff4e5;--warn-text:#7a4100;--warn-border:#f5c98a;--on-bg:#dbeafe;--on-text:#1d4ed8;color-scheme:light}
:root[data-theme=dark]{--bg:#1a1a1a;--bar:#1f1f1f;--bar2:#242424;--tab:#2d2d2d;--tab-on:#242424;--field:#2d2d2d;--field-on:#1a1a1a;--text:#fff;--text2:#a0a0a0;--muted:#6b6b6b;--border:#333;--hover:#383838;--card:#242424;--thumb:#1a1a1a;--accent:#3b82f6;--line:#404040;--warn-bg:#3a2a12;--warn-text:#fdba74;--warn-border:#7c4a12;--on-bg:#1e3a8a;--on-text:#bfdbfe;color-scheme:dark}`
// 시작 페이지: 빈 화면(about:blank) 대신 안내와 주소 입력란을 보여 준다 (아직 주소창 UI 가 없다)
const START_HTML = `<!doctype html><meta charset="utf-8"><title>에이전트 브라우저</title><style>${THEME_CSS}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text)}
.box{width:min(520px,86vw);text-align:center}h1{font-size:26px;font-weight:700;margin:0 0 12px}p{color:var(--text2);font-size:16px;margin:0 0 24px;line-height:1.7}
form{display:flex;gap:8px}input{flex:1;padding:13px 16px;border:1px solid var(--line);border-radius:10px;font-size:16px;background:var(--field-on);color:var(--text);outline:none}
input:focus{border-color:var(--accent)}button{padding:0 22px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
</style><div class="box"><h1>에이전트 브라우저</h1><p>에이전트가 웹 작업을 할 때 이 화면에서 실행됩니다.<br>직접 사이트를 열어 로그인해 두면 이후 작업에서도 유지됩니다.</p>
<form onsubmit="var v=this.u.value.trim();if(!v)return false;if(!/^https?:\/\//i.test(v))v='https://'+v;location.href=v;return false">
<input name="u" placeholder="주소를 입력하세요 (예: naver.com)" autofocus><button>이동</button></form></div>`
// 소개 화면(START_PAGE)은 브라우저에 열린 탭이 하나도 없을 때(처음 시작·모두 닫혔을 때·새 요청 시작)만 보여 준다.
// 이미 다른 탭이 있을 때 새로 여는 탭(새 탭, 병렬 세션 등)은 내용 없는 화면(BLANK_PAGE)으로 시작한다.
const BLANK_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>새 탭</title><style>${THEME_CSS}html,body{margin:0;height:100%;background:var(--bg)}</style>`)
const START_PAGE = process.env.AGENT_START_PAGE ?? 'data:text/html;charset=utf-8,' + encodeURIComponent(START_HTML)

// 같은 PC 의 백엔드만 붙을 수 있게 로컬에만 연다. (정식 버전은 토큰으로 보호되는 브리지로 교체 예정)
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT))
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

let win: BrowserWindow | null = null
let uiView: WebContentsView | null = null
let bannerView: WebContentsView | null = null
let toolbarView: WebContentsView | null = null
let splitterView: WebContentsView | null = null
let gridView: WebContentsView | null = null
let browserView: WebContentsView | null = null
// 작업 진행창(웹 UI 의 오른쪽 패널) 위치. right: [채팅][브라우저][작업 진행] (기본), left: [채팅][작업 진행][브라우저].
// right 일 때는 웹 UI 를 창 전체 폭으로 펴고, 웹 UI 가 브라우저 자리를 비워 두고 그 위치(slot)를 알려 주면 브라우저를 그 위에 얹는다.
let panelSide: 'left' | 'right' = 'left'
let slot: { x: number; w: number } | null = null // 웹 UI 가 알려 준 브라우저 자리 (창 기준 x, 너비)
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
// 사용자가 직접 해야 할 일(로그인·CAPTCHA) 안내 문구. 세션(탭)별로 따로 받고, 하나라도 있으면 배너를 계속 보여 준다
const attentions = new Map<string, string>()
const attentionText = () => [...attentions.values()].find((v) => v) ?? ''
let stopSeq = 0 // '중지'를 누른 횟수. 병렬 세션이 각자 비교해서 모두 멈춘다
let bannerShown = false
const agentActive = () => attentionText() !== '' || Date.now() - lastActivity < ACTIVE_MS

function refreshBanner() {
  const att = attentionText()
  const text = att || '에이전트가 이 브라우저를 조작 중입니다'
  bannerView?.webContents.executeJavaScript(`setBanner(${JSON.stringify(text)}, ${att === ''})`).catch(() => {})
}

const BANNER_HTML = `<!doctype html><meta charset="utf-8"><style>${THEME_CSS}
body{margin:0;height:${BANNER_H}px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;box-sizing:border-box;
font:13px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--warn-bg);color:var(--warn-text);border-bottom:1px solid var(--warn-border);user-select:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f97316;margin-right:8px;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.3}}button{border:0;border-radius:6px;padding:5px 12px;background:#d93025;color:#fff;font-size:12px;font-weight:600;cursor:pointer}
</style><body><span id="t"><i class="dot"></i>에이전트가 이 브라우저를 조작 중입니다</span><button id="b" onclick="banner.stop()">중지</button>
<script>function setBanner(text,showStop){document.getElementById('t').innerHTML='<i class="dot"></i>';document.getElementById('t').appendChild(document.createTextNode(text));document.getElementById('b').style.display=showStop?'':'none'}</script></body>`

// 데스크톱 사이트는 보통 1000~1280px 이상을 전제로 만들어져 있어, 우측 영역(창의 40%)에 그대로 넣으면 가로가 잘린다.
// 영역 너비가 FIT_WIDTH 보다 좁으면 페이지 배율을 줄여 '페이지 전체 너비'가 영역에 맞게 보이도록 한다.
const FIT_WIDTH = 1280
const MIN_FIT_ZOOM = 0.4
const MOBILE_W = 420
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
let fullMode = false // 전체 창 모드: 브라우저가 창 전체를 쓰고 채팅 화면은 가려진다
let userZoom = 1 // '맞춤' 배율에 곱하는 사용자 조절 값 (확대/축소)
let mobile = false // 모바일 환경 보기 (모바일 UA + 좁은 화면)
let browserSession: Electron.Session | null = null
let desktopUA = ''

// ── 탭 ────────────────────────────────────────────────────────────────────
interface Tab { id: number; view: WebContentsView; title: string; url: string; favicon: string; loading: boolean; targetId?: string; sid?: string; label?: string; lastUsed: number; intro?: boolean }
const MAX_TABS = 8 // 이 수를 넘으면 새 창 요청도 같은 탭에서 연다
const tabs: Tab[] = []
let activeId = 0
let nextTabId = 1
const activeTab = () => tabs.find((t) => t.id === activeId) ?? null
/**
 * 탭의 webContents. 페이지가 스스로 닫히거나(window.close) 렌더러가 사라지면 view.webContents 가 undefined 가 되어
 * 접근하는 순간 'Cannot read properties of undefined' 로 앱이 죽는다(네이버 예약 실행 중 발생). 살아 있을 때만 돌려준다.
 */
function liveWc(t: Tab | null | undefined): Electron.WebContents | null {
  const wc = t?.view?.webContents
  return wc && !wc.isDestroyed() ? wc : null
}

function paneWidth() {
  if (!win) return 0
  const w = win.getContentBounds().width
  return fullMode ? w : w - Math.round(w * split)
}
function effectiveZoom() {
  if (mobile) return Math.max(0.25, Math.min(3, userZoom))
  const fit = Math.max(MIN_FIT_ZOOM, Math.min(1, paneWidth() / FIT_WIDTH))
  return Math.max(0.25, Math.min(3, fit * userZoom))
}
function applyZoom(tab: Tab) {
  const wc = liveWc(tab)
  if (!wc) return
  // 시작 화면(data:)은 우리가 만든 안내 페이지라 '넓은 사이트용 축소'를 적용하지 않는다 (적용하면 글자가 너무 작아진다)
  const z = wc.getURL().startsWith('data:') ? 1 : effectiveZoom()
  if (Math.abs(wc.getZoomFactor() - z) > 0.01) wc.setZoomFactor(z)
}
function fitZoom() {
  for (const t of tabs) applyZoom(t)
  pushToolbar()
}
function stepZoom(dir: 'in' | 'out' | 'fit') {
  userZoom = dir === 'fit' ? 1 : Math.max(0.3, Math.min(4, userZoom * (dir === 'in' ? 1.2 : 1 / 1.2)))
  fitZoom()
}
function setZoomPercent(pct: number) {
  const base = effectiveZoom() / userZoom
  userZoom = Math.max(0.3, Math.min(4, pct / 100 / base))
  fitZoom()
}

function pushToolbar() {
  const t = activeTab()
  const wc = liveWc(t)
  const alive = !!wc
  const state = {
    tabs: tabs.map((x) => ({ id: x.id, title: x.title || (x.url.startsWith('data:') ? '' : x.url) || '새 탭', favicon: x.favicon, loading: x.loading, active: x.id === activeId, agent: !!x.sid })),
    sessions: sessionTabs().length,
    url: t && !t.url.startsWith('data:') ? t.url : '',
    canBack: !!alive && wc!.navigationHistory.canGoBack(),
    canForward: !!alive && wc!.navigationHistory.canGoForward(),
    loading: !!t?.loading,
    zoom: Math.round(effectiveZoom() * 100),
    mobile,
    full: fullMode,
  }
  toolbarView?.webContents.send('tb:state', state)
}

function createTab(url?: string, activate = true, sid?: string, label?: string): Tab | null {
  if (!win || !browserSession) return null
  const view = new WebContentsView({
    webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const tab: Tab = { id: nextTabId++, view, title: '', url: '', favicon: '', loading: false, sid, label, lastUsed: Date.now() }
  tabs.push(tab)
  win.contentView.addChildView(view)
  const wc = view.webContents
  if (mobile) wc.setUserAgent(MOBILE_UA)
  wc.setWindowOpenHandler(({ url: u }) => {
    if (!/^https?:\/\//i.test(u)) return { action: 'deny' }
    // 에이전트가 조작 중이거나(병렬 세션 포함) 탭이 이미 많으면 새 탭을 만들지 않고 같은 탭에서 연다.
    // 광고·링크가 여는 새 탭이 쌓여 닫히지 않는 것을 막고, 에이전트가 자기 탭에서 계속 작업하게 한다.
    if (tab.sid || agentActive() || tabs.length >= MAX_TABS) wc.loadURL(u).catch(() => {})
    else createTab(u) // 사용자가 직접 브라우징할 때의 target=_blank / window.open 은 새 탭으로 연다
    return { action: 'deny' }
  })
  // 페이지가 스스로 닫히거나 렌더러가 사라진 탭은 목록에 남겨 두면 줌·레이아웃 계산이 죽은 탭을 건드린다: 알아서 정리한다
  wc.once('destroyed', () => setImmediate(() => closeTab(tab.id)))
  wc.on('page-title-updated', (_e, title) => { tab.title = title; pushToolbar() })
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] ?? ''; pushToolbar() })
  wc.on('did-start-loading', () => { tab.loading = true; pushToolbar() })
  wc.on('did-stop-loading', () => { tab.loading = false; tab.url = wc.getURL(); pushToolbar() })
  wc.on('did-navigate', (_e, u) => {
    tab.url = u
    if (!u.startsWith('data:')) { tab.intro = false; pruneIntroTabs(tab) } // 실제 페이지가 열리면 소개 화면 탭은 없앤다
    applyZoom(tab)
    pushToolbar()
  })
  wc.on('did-navigate-in-page', (_e, u) => { tab.url = u; pushToolbar() })
  wc.on('dom-ready', () => { applyZoom(tab); themeView(tab.view, true) }) // 페이지 이동 시 배율이 사이트별 값으로 바뀔 수 있어 다시 맞춘다
  const first = url ?? (tabs.length === 1 ? START_PAGE : BLANK_PAGE) // 방금 추가한 이 탭 하나뿐이면 소개 화면
  tab.intro = first === START_PAGE
  tab.title = tab.intro ? '에이전트 브라우저' : first === BLANK_PAGE ? '새 탭' : '' // 제목이 올 때까지 주소(data: …)가 탭에 보이지 않게 미리 정한다
  wc.loadURL(first)
  if (activate) activateTab(tab.id)
  else layout()
  return tab
}

function activateTab(id: number, byUser = false) {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  activeId = id
  browserView = t.view
  lastStackKey = '' // 쌓는 순서는 restack() 이 한 곳에서 정한다 (여기서 탭을 직접 맨 위로 올리면 UI 위에 겹쳐 남는다)
  restack()
  layout()
}

let resettingTabs = false
function closeTab(id: number) {
  const i = tabs.findIndex((x) => x.id === id)
  if (i < 0) return
  const [t] = tabs.splice(i, 1)
  try { win?.contentView.removeChildView(t.view) } catch { /* 이미 제거됨 */ }
  const dead = liveWc(t)
  if (dead) {
    try { if (dead.debugger.isAttached()) dead.debugger.detach() } catch { /* 이미 분리됨 */ }
    dead.close()
  }
  if (tabs.length === 0) createTab()
  else if (id === activeId) activateTab((tabs.find((x) => !x.sid) ?? tabs[Math.min(i, tabs.length - 1)]).id)
  else layout()
  // 병렬 세션이 하나만 남으면 작은 창을 거두고 그 세션을 에이전트 브라우저로 보여 준다 (전체 정리 중에는 제외)
  if (t.sid && !resettingTabs && sessionTabs().length === 1) {
    autoShow()
    activateTab(sessionTabs()[0].id)
  }
}

/**
 * 소개 화면은 '열린 내용이 없을 때'만 보여 준다. 다른 탭이 실제 페이지를 열면(에이전트의 병렬 세션·새 탭 등) 아직 소개 화면인 탭은 닫는다.
 * (직접 연 빈 새 탭은 소개 화면이 아니므로 건드리지 않는다.)
 */
function pruneIntroTabs(keep: Tab) {
  for (const t of [...tabs]) if (t.intro && t.id !== keep.id && tabs.length > 1) closeTab(t.id)
}

function normalizeAddress(raw: string): string | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(v)) return 'http://' + v // 로컬·IP 주소는 보통 http
  if (/^\S+\.\S{2,}$/.test(v)) return 'https://' + v
  return 'https://www.google.com/search?q=' + encodeURIComponent(v)
}

async function attachScreenshot() {
  const t = activeTab()
  const twc = liveWc(t)
  if (!t || !uiView || !twc) return
  const img = await twc.capturePage()
  if (img.isEmpty()) return // 브라우저 영역이 접혀 있으면 캡처할 화면이 없다
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  uiView.webContents.send('browser:screenshot', { name: `browser-${stamp}.png`, data: img.toPNG().toString('base64') })
}

function setMobile(on: boolean) {
  mobile = on
  for (const t of tabs) {
    const wc = liveWc(t)
    if (!wc) continue
    wc.setUserAgent(on ? MOBILE_UA : desktopUA)
    if (!wc.getURL().startsWith('data:')) wc.reload() // 모바일 UA 를 적용하려면 다시 불러와야 한다
  }
  layout()
}

ipcMain.on('browser:zoom', (_e, dir: 'in' | 'out' | 'fit') => stepZoom(dir))
ipcMain.on('tb:act', (e, { type, arg }: { type: string; arg?: any }) => {
  if (!toolbarView || e.sender !== toolbarView.webContents) return // 툴바에서 온 요청만 받는다
  const wc = liveWc(activeTab()) ?? undefined
  switch (type) {
    case 'newTab': createTab(); break
    case 'closeTab': closeTab(Number(arg)); break
    case 'activate': activateTab(Number(arg), true); break
    case 'navigate': { const u = normalizeAddress(arg); if (u) wc?.loadURL(u).catch(() => {}); break }
    case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break
    case 'reload': if (activeTab()?.loading) wc?.stop(); else wc?.reload(); break
    case 'mobile': setMobile(!mobile); break
    case 'full': fullMode = !fullMode; layout(); break
    case 'closePane': closePane(); break
    case 'screenshot': attachScreenshot().catch(() => {}); break
    case 'external': { const u = wc?.getURL() ?? ''; if (/^https?:\/\//i.test(u)) shell.openExternal(u); break }
    case 'zoomMenu': {
      const mk = (pct: number) => ({ label: `${pct}%`, click: () => setZoomPercent(pct) })
      Menu.buildFromTemplate([
        { label: '화면에 맞춤', click: () => stepZoom('fit') }, { type: 'separator' },
        mk(50), mk(75), mk(100), mk(125), mk(150), mk(200),
      ]).popup({ window: win ?? undefined })
      break
    }
  }
})

// ── 병렬 작업 격자 ─────────────────────────────────────────────────────────
const PARALLEL_MAX = Number(process.env.AGENT_PARALLEL_MAX ?? 3)
const SESSION_IDLE_MS = 10 * 60 * 1000
const sessionTabs = () => tabs.filter((t) => t.sid)
const previewActive = () => sessionTabs().length >= 2 // 병렬로 2개 이상 실행될 때만 채팅 위에 미리보기 팝업을 띄운다 (1개면 에이전트 브라우저를 그대로 보여 준다)
const tabBySid = (sid?: string) => (sid ? tabs.find((t) => t.sid === sid) : undefined)

const CARD_W = 300
const CARD_H = 168
const CARD_GAP = 12
const PREVIEW_PAD = 10 // 그림자가 잘리지 않도록 카드 둘레에 둔 투명 여백
const PREVIEW_HTML = `<!doctype html><meta charset="utf-8"><style>${THEME_CSS}
*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--text);user-select:none}
#g{padding:${PREVIEW_PAD}px;display:flex;flex-direction:column;gap:${CARD_GAP}px}
.c{width:${CARD_W}px;height:${CARD_H}px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:pointer;
box-shadow:0 4px 18px #00000040;transition:border-color .12s,box-shadow .12s}
.c:hover{border-color:var(--accent);box-shadow:0 6px 22px #3b82f655}
.t{display:flex;align-items:center;gap:7px;padding:7px 10px;min-width:0;flex:none;background:var(--bar2);border-bottom:1px solid var(--border)}
.t img{width:14px;height:14px;border-radius:3px;flex:none}.t .ph{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);flex:none}
.t .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12px}
.d{width:8px;height:8px;border-radius:50%;background:#16a34a;flex:none}.d.l{background:#f97316;animation:p 1s infinite}@keyframes p{50%{opacity:.3}}
.s{flex:1;min-height:0;background:var(--thumb);overflow:hidden;position:relative}
.s img{width:100%;display:block}.s .e{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px}
</style><body><div id="g"></div><script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
gr.onState(s=>{
  document.getElementById('g').innerHTML=s.cells.map(c=>'<div class="c" data-id="'+c.id+'" title="클릭하면 이 탭을 브라우저에서 크게 봅니다"><div class="t">'+(c.favicon?'<img src="'+esc(c.favicon)+'">':'<span class="ph"></span>')+'<span class="n">'+esc(c.title||c.label)+'</span><span class="d'+(c.loading?' l':'')+'"></span></div><div class="s">'+(c.img?'<img src="'+c.img+'">':'<div class="e">'+esc(c.label)+' 불러오는 중…</div>')+'</div></div>').join('')
})
document.addEventListener('click',e=>{const c=e.target.closest('.c');if(c)gr.act('focus',Number(c.dataset.id))})
</script></body>`

let thumbTimer: NodeJS.Timeout | null = null
async function pushGrid() {
  if (!gridView || !previewActive()) return
  const cells = await Promise.all(sessionTabs().map(async (t) => {
    let img = ''
    try {
      const twc = liveWc(t)
      if (twc) {
        const shot = await twc.capturePage()
        if (!shot.isEmpty()) img = 'data:image/jpeg;base64,' + shot.resize({ width: 640 }).toJPEG(65).toString('base64')
      }
    } catch { /* 캡처 실패는 다음 주기에 다시 시도 */ }
    return { id: t.id, label: t.label || t.title || '작업', url: t.url.startsWith('data:') ? '' : t.url, title: t.title, favicon: t.favicon, loading: t.loading, img }
  }))
  if (previewActive()) gridView?.webContents.send('gr:state', { cells })
}
function syncGrid() {
  const on = previewActive()
  if (on && !thumbTimer) { thumbTimer = setInterval(() => { pushGrid().catch(() => {}) }, 800); pushGrid().catch(() => {}) }
  if (!on && thumbTimer) { clearInterval(thumbTimer); thumbTimer = null }
}
ipcMain.on('gr:act', (e, { type, arg }: { type: string; arg?: number }) => {
  if (!gridView || e.sender !== gridView.webContents) return
  if (type === 'focus') {
    // 미리보기를 누르면 우측 에이전트 브라우저를 열고 그 탭으로 이동한다
    browserHidden = false
    pinned = true
    autoShown = false
    activateTab(Number(arg), true)
  }
})

const ICON = {
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  stop: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  expand: '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
  shrink: '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
}
const svg = (k: keyof typeof ICON) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`

const TAB_H = 34
const NAV_H = 38
const TOOLBAR_H = TAB_H + NAV_H
const TOOLBAR_HTML = `<!doctype html><meta charset="utf-8"><style>${THEME_CSS}
*{box-sizing:border-box}body{margin:0;height:${TOOLBAR_H}px;font:12px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--bar);color:var(--text2);user-select:none;overflow:hidden}
#tabrow{height:${TAB_H}px;display:flex;align-items:flex-end}
#tabs{flex:1;min-width:0;height:${TAB_H}px;display:flex;align-items:flex-end;gap:2px;padding:4px 6px 0;overflow:hidden}
#winbtns{display:flex;gap:2px;align-self:center;padding-right:6px}
.tab{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 170px;height:30px;padding:0 6px 0 10px;border-radius:8px 8px 0 0;background:var(--tab);color:var(--text2);cursor:default}
.tab.on{background:var(--tab-on);color:var(--text)}.tab.ag::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}.tab .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tab img{width:14px;height:14px;border-radius:3px}.tab .x{display:flex;border:0;background:none;color:inherit;padding:2px;border-radius:50%;cursor:pointer;opacity:.6}
.tab .x:hover{background:#8884;opacity:1}
#nav{height:${NAV_H}px;display:flex;align-items:center;gap:4px;padding:0 8px;background:var(--bar2);border-bottom:1px solid var(--border)}
button.i{display:flex;align-items:center;justify-content:center;gap:2px;min-width:28px;height:28px;border:0;border-radius:6px;background:none;color:var(--text2);cursor:pointer;padding:0 5px;font-size:12px}
button.i:hover:not(:disabled){background:var(--hover)}button.i:disabled{opacity:.35;cursor:default}button.i.on{background:var(--on-bg);color:var(--on-text)}
#u{flex:1;min-width:0;height:28px;border:1px solid transparent;border-radius:14px;background:var(--field);padding:0 12px;font-size:12.5px;outline:none;color:var(--text)}
#u:focus{background:var(--field-on);border-color:var(--accent)}
</style><body><div id="tabrow"><div id="tabs"></div><div id="winbtns"><button class="i" id="fb" title="전체 창으로 보기" onclick="tb.act('full')"></button><button class="i" title="브라우저 닫기" onclick="tb.act('closePane')">${svg('stop')}</button></div></div><div id="nav">
<button class="i" id="bk" title="뒤로" onclick="tb.act('back')">${svg('back')}</button>
<button class="i" id="fw" title="앞으로" onclick="tb.act('forward')">${svg('forward')}</button>
<button class="i" id="rl" title="새로고침" onclick="tb.act('reload')">${svg('reload')}</button>
<input id="u" spellcheck="false" placeholder="주소 또는 검색어 입력" onkeydown="if(event.key==='Enter'){entered=true;tb.act('navigate',this.value);this.blur()}" onfocus="this.select()">
<button class="i" id="z" title="화면 비율" onclick="tb.act('zoomMenu')">100%${svg('chev')}</button>
<button class="i" id="mb" title="모바일 환경으로 보기" onclick="tb.act('mobile')">${svg('phone')}</button>
<button class="i" title="현재 화면을 스크린샷으로 채팅에 첨부" onclick="tb.act('screenshot')">${svg('clip')}</button>
<button class="i" title="기본 브라우저로 열기" onclick="tb.act('external')">${svg('ext')}</button>
</div><script>
const ICON_EXPAND='${svg('expand').replace(/'/g, "\\'")}',ICON_SHRINK='${svg('shrink').replace(/'/g, "\\'")}',ICON_RELOAD='${svg('reload').replace(/'/g, "\\'")}',ICON_STOP='${svg('stop').replace(/'/g, "\\'")}',ICON_X='${svg('stop').replace(/15/g, '12').replace(/'/g, "\\'")}',ICON_PLUS='${svg('plus').replace(/'/g, "\\'")}'
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
let cur='',dirty=false,entered=false
const U=document.getElementById('u')
U.addEventListener('input',()=>{dirty=true})
U.addEventListener('blur',()=>{dirty=false;if(!entered)U.value=cur;entered=false})
U.addEventListener('keydown',e=>{if(e.key==='Escape'){dirty=false;U.value=cur;U.select()}})
tb.onState(s=>{
  const t=document.getElementById('tabs')
  t.innerHTML=s.tabs.map(x=>'<div class="tab'+(x.active?' on':'')+(x.agent?' ag':'')+'" data-id="'+x.id+'" title="'+esc(x.title)+'">'+(x.favicon?'<img src="'+esc(x.favicon)+'">':'')+'<span class="t">'+esc(x.title)+'</span>'+(x.agent?'':'<button class="x" data-x="'+x.id+'">'+ICON_X+'</button>')+'</div>').join('')+'<button class="i" id="nt" title="새 탭" style="align-self:center">'+ICON_PLUS+'</button>'
  document.getElementById('bk').disabled=!s.canBack
  document.getElementById('fw').disabled=!s.canForward
  document.getElementById('rl').innerHTML=s.loading?ICON_STOP:ICON_RELOAD
  document.getElementById('rl').title=s.loading?'중지':'새로고침'
  cur=s.url; if(!dirty&&U.value!==s.url){U.value=s.url; if(document.activeElement===U) U.select()}
  document.getElementById('z').firstChild.nodeValue=s.zoom+'%'
  document.getElementById('mb').classList.toggle('on',s.mobile)
  const fb=document.getElementById('fb'); fb.innerHTML=s.full?ICON_SHRINK:ICON_EXPAND; fb.title=s.full?'전체 창 해제':'전체 창으로 보기'
})
document.addEventListener('click',e=>{
  const x=e.target.closest('[data-x]'); if(x){tb.act('closeTab',Number(x.dataset.x));return}
  if(e.target.closest('#nt')){tb.act('newTab');return}
  const t=e.target.closest('.tab'); if(t) tb.act('activate',Number(t.dataset.id))
})
document.addEventListener('auxclick',e=>{const t=e.target.closest('.tab'); if(t&&e.button===1) tb.act('closeTab',Number(t.dataset.id))})
</script></body>`

// ── 분할선: 채팅과 브라우저 사이 경계. 드래그해서 두 영역의 너비를 조절한다 ──
const SPLIT_W = 6
const SPLIT_MIN = 0.25 // UI(채팅)가 차지하는 최소 비율
const SPLIT_MAX = 0.8
const SPLIT_DEFAULT = 0.6
let dragTimer: NodeJS.Timeout | null = null
const SPLITTER_HTML = `<!doctype html><meta charset="utf-8"><style>${THEME_CSS}
html,body{margin:0;height:100%;overflow:hidden;background:transparent;cursor:col-resize;user-select:none}
#l{position:absolute;left:50%;top:0;bottom:0;width:1px;margin-left:-.5px;background:var(--line)}
body:hover #l,body.drag #l{width:3px;margin-left:-1.5px;background:var(--accent)}
</style><body><div id="l"></div><script>
document.body.addEventListener('pointerdown',e=>{document.body.setPointerCapture(e.pointerId);document.body.classList.add('drag');sp.act('start')})
const end=()=>{document.body.classList.remove('drag');sp.act('end')}
document.body.addEventListener('pointerup',end);document.body.addEventListener('pointercancel',end);document.body.addEventListener('lostpointercapture',end)
document.body.addEventListener('dblclick',()=>sp.act('reset'))
</script></body>`

function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
}
function startDrag() {
  stopDrag()
  browserHidden = false
  pinned = true
  autoShown = false
  // 포인터가 분할선 밖으로 나가도 따라가도록 커서 위치를 직접 읽는다
  dragTimer = setInterval(() => {
    if (!win) return stopDrag()
    const b = win.getContentBounds()
    const x = screen.getCursorScreenPoint().x - b.x
    // right: 브라우저 오른쪽 가장자리(작업 진행창은 너비가 고정)를 기준으로 커서까지가 브라우저 너비다
    const paneW = panelSide === 'right' && slot ? slot.x + slot.w - x : b.width - x
    const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, panelSide === 'right' && slot ? 1 - paneW / b.width : x / b.width))
    if (Math.abs(next - split) > 0.002) { split = next; layout() }
  }, 16)
}
ipcMain.on('split:act', (e, type: 'start' | 'end' | 'reset') => {
  if (!splitterView || e.sender !== splitterView.webContents) return
  if (type === 'start') startDrag()
  else if (type === 'end') stopDrag()
  else { stopDrag(); split = SPLIT_DEFAULT; layout() }
})
/**
 * 뷰 쌓는 순서를 다시 맞춘다 (아래 → 위): 탭 화면들(활성 탭이 맨 위) < 에이전트 UI < 미리보기 팝업 < 배너 < 툴바 < 분할선.
 * 탭 화면이 UI 아래에 있어야 브라우저가 접힌 동안에도 병렬 세션 탭이 창 안에서 그려지고(미리보기 캡처 가능) 사용자에겐 보이지 않는다.
 */
let lastStackKey = ''
function restack(rightMode = false) {
  if (!win) return
  const cv = win.contentView
  const order = [...tabs].sort((a, b) => Number(a.id === activeId) - Number(b.id === activeId))
  const key = (rightMode ? 'r' : '') + (browserHidden ? 'h:' : 's:') + order.map((t) => t.id).join(',') + (uiView ? '|u' : '') + (gridView ? 'g' : '') + (bannerView ? 'b' : '') + (toolbarView ? 't' : '') + (splitterView ? 's' : '')
  if (key === lastStackKey) return // 순서가 같으면 다시 쌓지 않는다 (분할선 드래그 중 깜빡임 방지)
  lastStackKey = key
  // right 모드: 웹 UI 가 창 전체를 덮으므로 브라우저 탭이 UI 위에 있어야 보인다 (UI 가 비워 둔 자리 위에 얹는다)
  if (rightMode && uiView) cv.addChildView(uiView)
  for (const t of order) cv.addChildView(t.view)
  for (const v of rightMode ? [gridView, bannerView, toolbarView, splitterView] : [uiView, gridView, bannerView, toolbarView, splitterView]) if (v) cv.addChildView(v)
}

/** 에이전트 작업 중지: 배너는 바로 숨기고, 백엔드는 다음 명령에서 중지를 확인한다 (병렬 세션 모두) */
function requestStop() {
  stopRequested = true
  stopSeq++
  lastActivity = 0
  bannerShown = false
  refreshBanner()
  layout()
  pushToolbar()
}

/** 브라우저 영역을 닫는다 (탭은 그대로 두고 채팅 화면만 전체로 돌아간다). 에이전트가 다시 브라우저를 쓰면 자동으로 열린다 */
function closePane() {
  fullMode = false
  browserHidden = true
  pinned = false
  autoShown = false
  layout()
}

function layout() {
  if (!win || !uiView) return
  const { width, height } = win.getContentBounds()
  const full = fullMode && !browserHidden
  const paneW = full ? width : width - Math.round(width * split)
  const rightMode = panelSide === 'right' && !browserHidden && !full
  // right 모드의 브라우저 위치: 웹 UI 가 알려 준 자리 (아직 모르면 기본 위치). 채팅 UI 는 창 전체를 쓴다.
  const paneX = rightMode && slot ? Math.max(0, Math.min(width - paneW, slot.x)) : width - paneW
  const uiW = browserHidden || rightMode ? width : width - paneW
  const chatRight = rightMode ? paneX : uiW // 채팅 영역의 오른쪽 끝 (미리보기 팝업 기준)
  // 전체 창 모드: 채팅 UI 는 크기를 유지한 채 창 밖으로 치운다 (크기를 줄이면 화면이 다시 배치된다)
  uiView.setBounds(full ? { x: -width, y: 0, width, height } : { x: 0, y: 0, width: uiW, height })
  const bannerH = bannerShown ? BANNER_H : 0
  const top = bannerH + TOOLBAR_H
  toolbarView?.setBounds({ x: browserHidden ? width : paneX, y: bannerH, width: paneW, height: TOOLBAR_H })
  const showBanner = bannerShown && !browserHidden
  bannerView?.setBounds({ x: paneX, y: 0, width: paneW, height: showBanner ? BANNER_H : 0 })
  bannerView?.setVisible(showBanner)
  splitterView?.setBounds({ x: browserHidden ? width : paneX - Math.round(SPLIT_W / 2), y: 0, width: SPLIT_W, height })
  splitterView?.setVisible(!browserHidden && !full)
  // 모바일 보기: 좁은 화면을 영역 가운데에 둔다
  const viewW = mobile ? Math.min(paneW, Math.round(MOBILE_W * effectiveZoom())) : paneW
  const viewX = paneX + Math.round((paneW - viewW) / 2)
  // 접힌 상태에서도 CDP 조작(클릭 좌표·스크린샷)이 되도록 같은 크기로 유지한다 (크기를 0 으로 줄이면 viewport 가 0 이 되어 조작이 깨진다).
  // 병렬 세션 탭은 접혀 있어도 창 안(UI 뒤)에 두어 그려지게 하고, 그 밖의 비활성 탭은 창 밖으로 민다.
  for (const t of tabs) {
    const inWindow = (t.id === activeId && !browserHidden) || !!t.sid
    t.view.setBounds({ x: inWindow ? viewX : width, y: top, width: viewW, height: height - top })
  }
  // 병렬 작업 미리보기 팝업: 채팅 영역 오른쪽 가장자리에 세로로 쌓는다
  if (gridView) {
    const n = sessionTabs().length
    const w = CARD_W + PREVIEW_PAD * 2
    const h = n * CARD_H + Math.max(0, n - 1) * CARD_GAP + PREVIEW_PAD * 2
    const shown = n >= 2 && !full
    gridView.setBounds({ x: shown ? chatRight - w - 6 : width, y: 84, width: w, height: Math.min(h, Math.max(0, height - 84 - 120)) })
    gridView.setVisible(shown)
  }
  restack(rightMode)
  syncGrid()
  fitZoom()
  pushUiLayout()
}

/** 웹 UI 에 브라우저 영역 상태를 알린다: right 모드에서 웹 UI 가 브라우저 자리를 비워 두는 데 쓴다 (바뀐 경우에만 보낸다) */
let lastUiLayout = ''
function pushUiLayout() {
  const wc = uiView?.webContents
  if (!wc || wc.isDestroyed()) return
  const state = { shown: !browserHidden && !fullMode, paneW: paneWidth(), side: panelSide }
  const key = JSON.stringify(state)
  if (key === lastUiLayout) return
  lastUiLayout = key
  wc.send('ui:layout', state)
}

/** 에이전트가 브라우저를 쓰기 시작할 때 접혀 있으면 자동으로 펼친다 */
function autoShow() {
  if (!browserHidden) return
  browserHidden = false
  autoShown = !pinned
  layout()
}

let theme: 'dark' | 'light' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
const themeScript = (t: string) => `document.documentElement.setAttribute('data-theme','${t}')`
function themeView(v: WebContentsView | null, onlyData = false) {
  const wc = v?.webContents
  if (!wc || wc.isDestroyed()) return
  if (onlyData && !wc.getURL().startsWith('data:')) return // 일반 웹 페이지는 건드리지 않는다 (시작 화면만 테마를 입힌다)
  wc.executeJavaScript(themeScript(theme)).catch(() => {})
}
function applyTheme(t: 'dark' | 'light') {
  theme = t
  nativeTheme.themeSource = t // 웹사이트의 prefers-color-scheme 도 앱 테마를 따라간다
  win?.setBackgroundColor(t === 'dark' ? '#1a1a1a' : '#ffffff')
  for (const v of [toolbarView, gridView, splitterView, bannerView]) themeView(v)
  for (const tab of tabs) themeView(tab.view, true)
}
/** 왼쪽 UI 의 <html data-theme> 값을 읽어 따라간다 */
async function syncTheme() {
  const wc = uiView?.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    const t = await wc.executeJavaScript(`document.documentElement.getAttribute('data-theme')`)
    if ((t === 'dark' || t === 'light') && t !== theme) applyTheme(t)
  } catch { /* UI 가 아직 로드되지 않음 */ }
}

function create() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    title: 'AI Agent',
    backgroundColor: theme === 'dark' ? '#1a1a1a' : '#ffffff',
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
  uiView.webContents.on('did-finish-load', () => { lastUiLayout = ''; pushUiLayout() })
  uiView.webContents.loadURL(UI_URL)

  // 내장 브라우저: 앱 UI 와 쿠키를 분리한 전용 파티션 (영구 저장)
  const ses = session.fromPartition('persist:agent-browser')
  // UA 에서 Electron 표식을 제거한다 (일부 사이트가 임베디드 브라우저를 막는다)
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sai-agent-desktop\/\S+/, ''))

  browserSession = ses
  desktopUA = ses.getUserAgent()
  createTab()

  bannerView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'banner-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(bannerView)
  bannerView.setVisible(false)
  toolbarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'toolbar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(toolbarView)
  toolbarView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOOLBAR_HTML))
  toolbarView.webContents.on('did-finish-load', () => { pushToolbar(); themeView(toolbarView) })
  gridView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'toolbar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(gridView)
  gridView.setVisible(false)
  gridView.webContents.on('did-finish-load', () => themeView(gridView))
  gridView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PREVIEW_HTML))
  splitterView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'splitter-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(splitterView)
  splitterView.webContents.on('did-finish-load', () => themeView(splitterView))
  splitterView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLITTER_HTML))
  bannerView.webContents.on('did-finish-load', () => themeView(bannerView))
  bannerView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BANNER_HTML))
  setInterval(() => {
    syncTheme().catch(() => {})
    for (const t of [...tabs]) if (t.sid && Date.now() - t.lastUsed > SESSION_IDLE_MS) closeTab(t.id) // 백엔드가 닫지 못한 병렬 탭 정리
    const show = agentActive()
    if (show !== bannerShown) { bannerShown = show; refreshBanner(); layout() }
    // 에이전트가 한동안 쓰지 않으면 자동으로 접는다 (사용자가 직접 펼친 경우는 제외)
    if (autoShown && !pinned && !browserHidden && attentionText() === '' && Date.now() - lastActivity > HIDE_IDLE_MS) {
      browserHidden = true
      autoShown = false
      layout()
    }
  }, 1000)

  win.on('resize', layout)
  layout()
  win.on('closed', () => { win = null; uiView = null; bannerView = null; toolbarView = null; splitterView = null; gridView = null; browserView = null; tabs.length = 0; lastStackKey = ''; stopDrag(); syncGrid() })
}

/**
 * 백엔드가 UI 창과 내장 브라우저를 구분할 수 있게, 내장 브라우저의 CDP targetId 를 알려 주는 로컬 전용 info 서버.
 * (CDP 의 /json 목록에는 어느 페이지가 에이전트 브라우저인지 표시가 없다)  포트는 CDP 포트 + 1, 127.0.0.1 에만 바인드.
 */
async function sessionTargetId(sid: string): Promise<string | null> {
  const t = tabBySid(sid)
  return t ? browserTargetId(t) : null
}
async function browserTargetId(target?: Tab): Promise<string | null> {
  const tab = target ?? activeTab() // 기본은 사용자가 보고 있는(활성) 탭 (병렬 세션은 자기 탭)
  const wc = liveWc(tab)
  if (!tab || !wc) return null
  if (tab.targetId) return tab.targetId
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    const r = await wc.debugger.sendCommand('Target.getTargetInfo')
    tab.targetId = r?.targetInfo?.targetId ?? undefined
    return tab.targetId ?? null
  } catch {
    return null
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}
const sendJson = (res: http.ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function startInfoServer() {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/activity') {
      // 백엔드가 명령을 보낼 때마다 호출: 조작 중 표시를 갱신하고, 사용자가 누른 '중지'를 알린다
      const body = await readJson(req)
      const stop = stopRequested // 구버전 백엔드용: 한 번만 전달
      stopRequested = false
      let opened = false // 이번 호출로 접혀 있던 브라우저가 펼쳐졌는가 (펼쳐진 직후엔 크기가 잡힐 때까지 잠깐 기다려야 한다)
      const st = tabBySid(String(body.sid ?? ''))
      if (st) st.lastUsed = Date.now()
      if (!stop) {
        if (!st) { // 병렬 세션은 브라우저를 펼치지 않는다 (채팅 위 미리보기로 보여 주고, 눌렀을 때 연다)
          opened = browserHidden
          autoShow()
        }
        lastActivity = Date.now()
        if (!bannerShown) { bannerShown = true; refreshBanner(); layout() }
      }
      return sendJson(res, 200, { stop, stopSeq, opened, targetId: await browserTargetId() })
    }
    if (req.method === 'POST' && url.pathname === '/attention') {
      const body = await readJson(req)
      const sid = String(body.sid ?? '')
      const msg = String(body.message ?? '').slice(0, 200)
      attentions.set(sid, msg)
      if (!msg) attentions.delete(sid)
      if (msg) {
        const t = tabBySid(sid)
        if (t) activateTab(t.id) // 사용자가 처리해야 하는 탭을 브라우저에서 보여 준다 (아래 autoShow 로 영역도 연다)
        autoShow(); lastActivity = Date.now(); bannerShown = true; browserView?.webContents.focus()
      } else lastActivity = 0
      refreshBanner()
      layout()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/tabs') {
      // 병렬 작업용 전용 탭: 사용자가 보던 탭은 그대로 두고 뒤에서 만든다
      const sid = String((await readJson(req)).sid ?? '')
      if (!sid || tabBySid(sid)) return sendJson(res, 200, { ok: !!sid })
      if (sessionTabs().length >= PARALLEL_MAX) return sendJson(res, 200, { ok: false, error: `병렬 브라우저는 최대 ${PARALLEL_MAX}개까지 열 수 있습니다` })
      lastActivity = Date.now()
      const tab = createTab(undefined, false, sid, '')
      layout()
      // 곧 다른 병렬 세션이 이어서 열릴 수 있으므로 잠깐 기다린다. 끝내 1개뿐이면 작은 창이 아니라 에이전트 브라우저를 그대로 보여 주고,
      // 2개 이상이면 브라우저 영역은 펼치지 않고 채팅 위 미리보기 팝업만 나타난다.
      await new Promise((r) => setTimeout(r, 350))
      if (tab && sessionTabs().length === 1 && tabs.includes(tab)) {
        autoShow()
        activateTab(tab.id)
      }
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/tabs/reset') {
      // 새 요청 시작: 남아 있는 탭(이전 검색 탭, 병렬 세션 포함)을 모두 닫고 깨끗한 탭 하나로 시작한다 (로그인 쿠키는 유지)
      resettingTabs = true
      for (const t of [...tabs]) closeTab(t.id) // 마지막 탭을 닫으면 소개 화면의 새 탭이 하나 만들어진다
      resettingTabs = false
      attentions.clear()
      refreshBanner()
      layout()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/tabs/close') {
      const t = tabBySid(String((await readJson(req)).sid ?? ''))
      if (t) closeTab(t.id)
      attentions.delete(String(t?.sid ?? ''))
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname === '/agent-browser') {
      const sid = url.searchParams.get('sid') ?? ''
      const targetId = sid ? await sessionTargetId(sid) : await browserTargetId()
      return sendJson(res, targetId ? 200 : 503, targetId ? { targetId } : { error: 'browser not ready' })
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

ipcMain.on('agent:stop', () => requestStop())
ipcMain.handle('desktop:info', () => ({
  serverUrl: SERVER_URL,
  cdpPort: CDP_PORT,
  platform: process.platform,
}))
ipcMain.handle('browser:navigate', (_e, url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 열 수 있습니다')
  return browserView?.webContents.loadURL(url)
})
// 작업 진행창 위치 (웹 UI 가 정한다). 바뀌면 브라우저 자리를 다시 받을 때까지 기본 위치에 둔다
ipcMain.handle('browser:set-panel-side', (e, side: string) => {
  if (!uiView || e.sender !== uiView.webContents) throw new Error('허용되지 않은 호출입니다')
  if (side !== 'left' && side !== 'right') return
  if (panelSide === side) { lastUiLayout = ''; pushUiLayout(); return } // 웹 UI 가 다시 로드된 경우: 현재 상태를 다시 알린다
  panelSide = side
  slot = null
  lastStackKey = ''
  layout()
})
// 웹 UI 가 비워 둔 브라우저 자리(right 모드): 창 기준 x 와 너비
ipcMain.on('browser:set-slot', (e, rect: { x?: number; width?: number }) => {
  if (!uiView || e.sender !== uiView.webContents) return
  const x = Math.round(Number(rect?.x)), w = Math.round(Number(rect?.width))
  if (!Number.isFinite(x) || !Number.isFinite(w) || w < 1) return
  if (slot && slot.x === x && slot.w === w) return
  slot = { x, w }
  if (panelSide === 'right') layout()
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
          if (browserHidden) fullMode = false
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
        { label: '새 탭', accelerator: 'CmdOrCtrl+T', click: () => { browserHidden = false; pinned = true; createTab() } },
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
