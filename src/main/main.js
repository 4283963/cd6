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
const SOCKET_COUNT = 20;
let dbReady = false;

let pendingSocketUpdate = false;
let lastUpdateTime = 0;
const UPDATE_THROTTLE_MS = 33;

const isStressTest = process.argv.includes('--stress');
const isAgingTest = process.argv.includes('--aging-test');

let powerHistoryBuffers = {};
let agingDetectedMap = {};
let agingCooldownMap = {};
const POWER_BUFFER_SIZE = 60;
const AGING_CHECK_INTERVAL_MS = 5000;
const AGING_CHARGE_THRESHOLD_MS = 30 * 60 * 1000;
const AGING_VOLATILITY_THRESHOLD = 0.40;
const AGING_PERSISTENT_COUNT = 3;
const AGING_SPIKE_THRESHOLD = 0.25;

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
    const id = i + 1;
    chargingSockets.push({
      id,
      status: 'idle',
      current: 0,
      voltage: 220,
      power: 0,
      energy: 0,
      startTime: null,
      temperature: 25
    });
    powerHistoryBuffers[id] = [];
    agingDetectedMap[id] = false;
    agingCooldownMap[id] = 0;
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

  ipcMain.handle('acknowledge-aging-alarm', async (event, socketId) => {
    agingDetectedMap[socketId] = false;
    agingCooldownMap[socketId] = Date.now() + 30 * 60 * 1000;
    agingCheckCounters[socketId] = 0;
    return { success: true };
  });
}

function recordPowerSample(socketId, power) {
  const buffer = powerHistoryBuffers[socketId];
  if (!buffer) return;
  buffer.push({ time: Date.now(), power });
  if (buffer.length > POWER_BUFFER_SIZE) {
    buffer.shift();
  }
}

function calculateVolatility(buffer) {
  if (buffer.length < 10) return { volatility: 0, spikeCount: 0 };

  let sum = 0;
  buffer.forEach(s => sum += s.power);
  const mean = sum / buffer.length;

  if (mean < 50) return { volatility: 0, spikeCount: 0 };

  let variance = 0;
  let spikeCount = 0;
  let prevPower = buffer[0].power;

  buffer.forEach((s, i) => {
    variance += Math.pow(s.power - mean, 2);
    if (i > 0) {
      const change = Math.abs(s.power - prevPower) / mean;
      if (change > AGING_SPIKE_THRESHOLD) {
        spikeCount++;
      }
    }
    prevPower = s.power;
  });
  variance /= buffer.length;

  const stdDev = Math.sqrt(variance);
  return {
    volatility: stdDev / mean,
    spikeCount,
    spikeRate: spikeCount / buffer.length
  };
}

let agingCheckCounters = {};

function checkAgingBattery(socket) {
  const id = socket.id;

  if (agingDetectedMap[id]) return;

  const now = Date.now();
  if (agingCooldownMap[id] && now < agingCooldownMap[id]) return;

  if (!socket.startTime || (now - socket.startTime) < AGING_CHARGE_THRESHOLD_MS) return;

  const buffer = powerHistoryBuffers[id];
  if (!buffer || buffer.length < 30) return;

  const metrics = calculateVolatility(buffer);

  if (metrics.volatility > AGING_VOLATILITY_THRESHOLD && metrics.spikeRate > 0.1) {
    agingCheckCounters[id] = (agingCheckCounters[id] || 0) + 1;

    if (agingCheckCounters[id] >= AGING_PERSISTENT_COUNT) {
      triggerAgingAlarm(socket, metrics.volatility);
      agingDetectedMap[id] = true;
      agingCheckCounters[id] = 0;
    }
  } else {
    agingCheckCounters[id] = Math.max(0, (agingCheckCounters[id] || 0) - 1);
  }
}

function triggerAgingAlarm(socket, volatility) {
  const message = '电瓶老化风险：充电末期功率波动剧烈（波动率 ' + (volatility * 100).toFixed(1) + '%），可能存在过热危险，请立即前往检查！';

  if (dbReady) {
    db.addAlarmLog(socket.id, 'battery_aging', message);
  }

  if (mainWindow) {
    mainWindow.webContents.send('aging-alarm', {
      socketId: socket.id,
      message,
      volatility: volatility,
      power: socket.power,
      temperature: socket.temperature,
      timestamp: Date.now()
    });
  }

  console.warn('⚠️  电瓶老化告警 - 插座 #' + socket.id + ' 波动率: ' + (volatility * 100).toFixed(1) + '%');
}

function startAgingDetection() {
  chargingSockets.forEach(s => {
    agingCheckCounters[s.id] = 0;
  });

  setInterval(() => {
    chargingSockets.forEach(socket => {
      if (socket.status === 'charging') {
        recordPowerSample(socket.id, socket.power);
        checkAgingBattery(socket);
      } else if (socket.status === 'idle') {
        powerHistoryBuffers[socket.id] = [];
        agingDetectedMap[socket.id] = false;
        agingCheckCounters[socket.id] = 0;
      }
    });
  }, AGING_CHECK_INTERVAL_MS / POWER_BUFFER_SIZE * 2);
}

function throttleSocketUpdate() {
  if (pendingSocketUpdate) return;
  pendingSocketUpdate = true;

  const now = Date.now();
  const delay = Math.max(0, UPDATE_THROTTLE_MS - (now - lastUpdateTime));

  setTimeout(() => {
    pendingSocketUpdate = false;
    lastUpdateTime = Date.now();
    if (mainWindow) {
      const lightSockets = chargingSockets.map(s => ({
        id: s.id,
        status: s.status,
        current: s.current,
        voltage: s.voltage,
        power: s.power,
        energy: s.energy,
        temperature: s.temperature
      }));
      mainWindow.webContents.send('socket-update', lightSockets);
    }
  }, delay);
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

  throttleSocketUpdate();
}

function simulateData() {
  const interval = isStressTest ? 50 : 1000;

  if (isStressTest || isAgingTest) {
    chargingSockets.forEach(socket => {
      socket.status = 'charging';
      socket.startTime = Date.now() - 60 * 60 * 1000;
    });
    console.log('模拟模式：' + SOCKET_COUNT + ' 路插座同时充电，数据频率 ' + (1000 / interval) + 'Hz');
    if (isAgingTest) {
      console.log('🧪 老化测试模式：插座 #3、#7、#12 将模拟老化电瓶功率剧烈波动');
    }
  }

  const agingSockets = isAgingTest ? [3, 7, 12] : [];
  let normalBasePower = {};
  for (let i = 1; i <= SOCKET_COUNT; i++) {
    normalBasePower[i] = 500 + Math.random() * 1500;
  }

  setInterval(() => {
    let hasChange = false;
    chargingSockets.forEach(socket => {
      if (socket.status === 'charging') {
        const isAging = agingSockets.includes(socket.id);

        if (isAging) {
          const basePower = 800 + Math.random() * 400;
          const spike = Math.random() < 0.35 ? (Math.random() - 0.5) * 1500 : 0;
          socket.power = Math.max(100, basePower + spike);
          socket.current = socket.power / 220;
          socket.voltage = 218 + Math.random() * 4;
          socket.temperature = 38 + Math.random() * 18 + (Math.abs(spike) > 500 ? 5 : 0);
        } else {
          normalBasePower[socket.id] += (Math.random() - 0.5) * 5;
          normalBasePower[socket.id] = Math.max(300, Math.min(2000, normalBasePower[socket.id]));
          const noise = (Math.random() - 0.5) * normalBasePower[socket.id] * 0.08;
          socket.power = normalBasePower[socket.id] + noise;
          socket.current = socket.power / 220;
          socket.voltage = 218 + Math.random() * 6;
          socket.temperature = 28 + Math.random() * 6;
        }

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

    if (hasChange) {
      throttleSocketUpdate();
    }
  }, interval);
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
  startAgingDetection();

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
