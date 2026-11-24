import { contextBridge, ipcRenderer } from 'electron'

// 웹 UI 가 쓸 수 있는 최소한의 데스크톱 API (Node 권한은 노출하지 않는다)
contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  browser: {
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    setSplit: (ratio: number) => ipcRenderer.invoke('browser:set-split', ratio),
    // 작업 진행창 위치: right 면 [채팅][브라우저][작업 진행]. 웹 UI 가 브라우저 자리를 비워 두고 그 위치를 알려 준다
    setPanelSide: (side: 'left' | 'right') => ipcRenderer.invoke('browser:set-panel-side', side),
    setSlot: (rect: { x: number; width: number }) => ipcRenderer.send('browser:set-slot', rect),
    // 브라우저 영역 상태(보이는지, 너비)가 바뀔 때마다 받는다. 해제 함수를 돌려준다
    onLayout: (cb: (s: { shown: boolean; paneW: number; side: 'left' | 'right' }) => void) => {
      const h = (_e: unknown, s: { shown: boolean; paneW: number; side: 'left' | 'right' }) => cb(s)
      ipcRenderer.on('ui:layout', h)
      return () => { ipcRenderer.removeListener('ui:layout', h) }
    },
    // 브라우저 툴바의 '스크린샷 첨부' 버튼: 현재 화면 PNG(base64)를 받아 채팅 첨부로 올린다. 해제 함수를 돌려준다
    onScreenshot: (cb: (shot: { name: string; data: string }) => void) => {
      const h = (_e: unknown, shot: { name: string; data: string }) => cb(shot)
      ipcRenderer.on('browser:screenshot', h)
      return () => { ipcRenderer.removeListener('browser:screenshot', h) }
    },
  },
  // 로컬 Chrome 의 로그인 쿠키 가져오기: 현재 에이전트 브라우저의 사이트만, 개수만 돌려준다 (쿠키 값은 UI 로 나오지 않는다)
  chrome: {
    check: () => ipcRenderer.invoke('chrome:check'),
    importCookies: () => ipcRenderer.invoke('chrome:import'),
  },
})

// 서버 주소가 지정되면 웹 UI 가 그 주소를 사용한다 (frontend/src/config/server.ts)
const serverUrl = process.env.AGENT_SERVER_URL
if (serverUrl) contextBridge.exposeInMainWorld('__AGENT_SERVER_URL__', serverUrl)
