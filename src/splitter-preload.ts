import { contextBridge, ipcRenderer } from 'electron'

// 채팅 영역과 브라우저 영역 사이 분할선: 드래그 시작·끝·초기화만 메인 프로세스에 알린다
contextBridge.exposeInMainWorld('sp', {
  act: (type: 'start' | 'end' | 'reset') => ipcRenderer.send('split:act', type),
})
