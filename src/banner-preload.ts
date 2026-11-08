import { contextBridge, ipcRenderer } from 'electron'

// 조작 중 배너의 '중지' 버튼만 메인 프로세스로 전달한다
contextBridge.exposeInMainWorld('banner', {
  stop: () => ipcRenderer.send('agent:stop'),
  zoom: (dir: 'in' | 'out' | 'fit') => ipcRenderer.send('browser:zoom', dir),
})
