const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('./db');
const Protocol = require('./protocol');

let SerialManager;
try {
  SerialManager = require('./serial');
} catch (e) {
  console.warn('串口模块加载失败:', e.message);
  SerialManager = null;
}

let mainWindow;
let db;
let serialManager;
let protocol;

let chargingSockets = [];
const SOCKET_COUNT = 12;
let dbReady = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: '智能充电桩功率监测系统',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function initSockets() {
  for (let i = 0; i < SOCKET_COUNT; i++) {
    chargingSockets.push({
      id: i + 1,
      status: 'idle',
      current: 0,
      voltage: 220,
      power: 0,
      energy: 0,
      startTime: null,
      temperature: 25
    });
  }
}

function initIpcHandlers() {
  ipcMain.handle('get-sockets', () => {
    return chargingSockets;
  });

  ipcMain.handle('get-serial-ports', async () => {
    try {
      if (!serialManager) return [];
      return await serialManager.listPorts();
    } catch (error) {
      console.error('获取串口列表失败:', error);
      return [];
    }
  });

  ipcMain.handle('connect-serial', async (event, portPath, baudRate) => {
    try {
      if (!serialManager) return { success: false, error: '串口模块不可用' };
      await serialManager.connect(portPath, baudRate);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('disconnect-serial', async () => {
    try {
      if (!serialManager) return { success: true };
      await serialManager.disconnect();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-charging-records', async (event, { page, pageSize }) => {
    try {
      if (!dbReady) return { records: [], total: 0, page, pageSize };
      return db.getChargingRecords(page, pageSize);
    } catch (error) {
      console.error('获取充电记录失败:', error);
      return { records: [], total: 0, page, pageSize };
    }
  });

  ipcMain.handle('get-alarm-logs', async (event, { page, pageSize }) => {
    try {
      if (!dbReady) return { logs: [], total: 0, page, pageSize };
      return db.getAlarmLogs(page, pageSize);
    } catch (error) {
      console.error('获取告警日志失败:', error);
      return { logs: [], total: 0, page, pageSize };
    }
  });

  ipcMain.handle('start-charging', async (event, socketId) => {
    try {
      const socket = chargingSockets.find(s => s.id === socketId);
      if (socket && socket.status === 'idle') {
        socket.status = 'charging';
        socket.startTime = Date.now();
        socket.energy = 0;
        if (dbReady) {
          db.startChargingRecord(socketId);
        }
        if (serialManager && serialManager.isConnected()) {
          const cmd = protocol.buildStartCommand(socketId);
          serialManager.send(cmd);
        }
        return { success: true };
      }
      return { success: false, error: '插座不可用' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('stop-charging', async (event, socketId) => {
    try {
      const socket = chargingSockets.find(s => s.id === socketId);
      if (socket && socket.status === 'charging') {
        const duration = (Date.now() - socket.startTime) / 1000 / 3600;
        if (dbReady) {
          db.endChargingRecord(socket.id, socket.energy, duration);
        }
        socket.status = 'idle';
        socket.startTime = null;
        socket.current = 0;
        socket.power = 0;
        if (serialManager && serialManager.isConnected()) {
          const cmd = protocol.buildStopCommand(socketId);
          serialManager.send(cmd);
        }
        return { success: true };
      }
      return { success: false, error: '插座未在充电' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-daily-stats', async () => {
    try {
      if (!dbReady) return { totalEnergy: 0, totalCount: 0, alarms: 0 };
      return db.getDailyStats();
    } catch (error) {
      console.error('获取每日统计失败:', error);
      return { totalEnergy: 0, totalCount: 0, alarms: 0 };
    }
  });
}

function handleProtocolData(frames) {
  if (!Array.isArray(frames)) return;

  frames.forEach(frame => {
    if (frame.type === 'status') {
      const socket = chargingSockets.find(s => s.id === frame.socketId);
      if (socket) {
        socket.voltage = frame.voltage;
        socket.current = frame.current;
        socket.power = frame.power;
        socket.temperature = frame.temperature;
        if (frame.status === 'charging' && socket.status !== 'alarm') {
          socket.status = 'charging';
        }
        if (frame.status === 'alarm') {
          socket.status = 'alarm';
        }
        if (dbReady) {
          db.addPowerHistory(
            frame.socketId,
            frame.voltage,
            frame.current,
            frame.power,
            frame.temperature
          );
        }
      }
    } else if (frame.type === 'alarm') {
      const socket = chargingSockets.find(s => s.id === frame.socketId);
      if (socket) {
        socket.status = 'alarm';
      }
      if (dbReady) {
        db.addAlarmLog(frame.socketId, frame.alarmType, frame.message);
      }
      if (mainWindow) {
        mainWindow.webContents.send('new-alarm', frame);
      }
    }
  });

  if (mainWindow) {
    mainWindow.webContents.send('socket-update', chargingSockets);
  }
}

function simulateData() {
  setInterval(() => {
    let hasChange = false;
    chargingSockets.forEach(socket => {
      if (socket.status === 'charging') {
        socket.voltage = 215 + Math.random() * 10;
        socket.current = 1 + Math.random() * 5;
        socket.power = socket.voltage * socket.current;
        socket.temperature = 25 + Math.random() * 10;
        socket.energy += socket.power / 1000 / 3600;
        if (Math.random() < 0.001 && socket.temperature > 50) {
          socket.status = 'alarm';
          if (dbReady) {
            db.addAlarmLog(socket.id, 'overheat', '温度过高: ' + socket.temperature.toFixed(1) + '°C');
          }
        }
        hasChange = true;
      } else if (socket.status === 'alarm') {
        hasChange = true;
      }
    });

    if (hasChange && mainWindow) {
      mainWindow.webContents.send('socket-update', chargingSockets);
    }
  }, 1000);
}

app.whenReady().then(async () => {
  db = new Database(path.join(app.getPath('userData'), 'charging.db'));
  try {
    await db.init();
    dbReady = true;
  } catch (e) {
    console.error('数据库初始化失败:', e);
  }

  protocol = new Protocol();

  try {
    serialManager = new SerialManager();
    serialManager.on('data', (data) => {
      const parsed = protocol.parse(data);
      if (parsed) {
        handleProtocolData(parsed);
      }
    });

    serialManager.on('error', (error) => {
      console.error('串口错误:', error);
      if (mainWindow) {
        mainWindow.webContents.send('serial-error', error.message);
      }
    });
  } catch (e) {
    console.warn('串口模块加载失败，将使用模拟数据:', e.message);
    serialManager = {
      isConnected: () => false,
      listPorts: async () => [],
      connect: async () => { throw new Error('串口模块不可用'); },
      disconnect: async () => {},
      send: async () => {},
      on: () => {}
    };
  }

  initSockets();
  initIpcHandlers();
  createWindow();
  simulateData();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serialManager && serialManager.disconnect) {
      serialManager.disconnect();
    }
    if (db && db.close) {
      db.close();
    }
    app.quit();
  }
});
