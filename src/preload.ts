import { contextBridge, ipcRenderer } from 'electron'

// 웹 UI 가 쓸 수 있는 최소한의 데스크톱 API (Node 권한은 노출하지 않는다)
contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  browser: {
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    setSplit: (ratio: number) => ipcRenderer.invoke('browser:set-split', ratio),
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
