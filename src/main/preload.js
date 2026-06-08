const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSockets: () => ipcRenderer.invoke('get-sockets'),
  getSerialPorts: () => ipcRenderer.invoke('get-serial-ports'),
  connectSerial: (portPath, baudRate) => ipcRenderer.invoke('connect-serial', portPath, baudRate),
  disconnectSerial: () => ipcRenderer.invoke('disconnect-serial'),
  startCharging: (socketId) => ipcRenderer.invoke('start-charging', socketId),
  stopCharging: (socketId) => ipcRenderer.invoke('stop-charging', socketId),
  getChargingRecords: (page, pageSize) => ipcRenderer.invoke('get-charging-records', { page, pageSize }),
  getAlarmLogs: (page, pageSize) => ipcRenderer.invoke('get-alarm-logs', { page, pageSize }),
  getDailyStats: () => ipcRenderer.invoke('get-daily-stats'),
  acknowledgeAgingAlarm: (socketId) => ipcRenderer.invoke('acknowledge-aging-alarm', socketId),
  onSocketUpdate: (callback) => {
    ipcRenderer.on('socket-update', (event, data) => callback(data));
  },
  onSerialError: (callback) => {
    ipcRenderer.on('serial-error', (event, error) => callback(error));
  },
  onAgingAlarm: (callback) => {
    ipcRenderer.on('aging-alarm', (event, data) => callback(data));
  }
});
