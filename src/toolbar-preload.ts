import { contextBridge, ipcRenderer } from 'electron'

// 브라우저 상단 툴바(탭·주소창·버튼)가 메인 프로세스로 동작을 전달한다
contextBridge.exposeInMainWorld('tb', {
  act: (type: string, arg?: unknown) => ipcRenderer.send('tb:act', { type, arg }),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('tb:state', (_e, s) => cb(s)),
})

// 병렬 작업 격자 화면(작은 창 모음): 칸을 누르면 그 세션을 큰 화면으로 연다
contextBridge.exposeInMainWorld('gr', {
  act: (type: string, arg?: unknown) => ipcRenderer.send('gr:act', { type, arg }),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('gr:state', (_e, s) => cb(s)),
})
