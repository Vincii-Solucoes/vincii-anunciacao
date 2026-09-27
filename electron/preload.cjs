const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.off(channel, fn);
};

contextBridge.exposeInMainWorld('vincii', {
  platform: process.platform,
  net: {
    udpOpen: (opts) => ipcRenderer.invoke('net:udpOpen', opts),
    udpSend: (id, data, port, host) => ipcRenderer.send('net:udpSend', id, data, port, host),
    streamConnect: (opts) => ipcRenderer.invoke('net:streamConnect', opts),
    streamSend: (id, text) => ipcRenderer.send('net:streamSend', id, text),
    close: (id) => ipcRenderer.send('net:close', id),
    resolve: (opts) => ipcRenderer.invoke('net:resolve', opts),
    localAddress: (opts) => ipcRenderer.invoke('net:localAddress', opts),
    onMessage: on('net:message'),
    onClose: on('net:close'),
    onError: on('net:error'),
  },
  secret: {
    encrypt: (text) => ipcRenderer.invoke('secret:encrypt', text),
    decrypt: (data) => ipcRenderer.invoke('secret:decrypt', data),
  },
  app: {
    getSystem: () => ipcRenderer.invoke('app:getSystem'),
    setSystem: (patch) => ipcRenderer.invoke('app:setSystem', patch),
    status: (s) => ipcRenderer.send('app:status', s),
    show: () => ipcRenderer.send('app:show'),
    setTheme: (source) => ipcRenderer.send('app:theme', source),
    quit: () => ipcRenderer.send('app:quit'),
    onDial: on('app:dial'),
    onDnd: on('app:dnd'),
    onSystem: on('app:system'),
  },
});
