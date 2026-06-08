let sockets = [];
let powerHistory = {};
let currentChartType = 'power';
let isConnected = false;
let socketElements = {};

const MAX_HISTORY = 120;
const SOCKET_COLORS = [
  '#00d4ff', '#00ff88', '#ff6b6b', '#ffb84d',
  '#7b2cbf', '#ff6b9d', '#4ecdc4', '#ffe66d',
  '#95e1d3', '#f38181', '#aa96da', '#fcbad3',
  '#a8e6cf', '#dcedc1', '#ffd3b6', '#ffaaa5',
  '#6c5ce7', '#00b894', '#fdcb6e', '#e17055'
];

let pendingRender = false;
let chartDirty = true;
let statsDirty = true;
let historyDirty = false;

let bgCanvas = null;
let bgCtx = null;
let bgDirty = true;

let chartWidth = 0;
let chartHeight = 0;
let chartPadding = { top: 20, right: 20, bottom: 30, left: 50 };
let lastMaxValue = 0;
let lastMinValue = 0;

let agingAlarmQueue = [];
let agingAlarmVisible = false;

function init() {
  loadSockets();
  setupEventListeners();
  setupSocketUpdateListener();
  setupAgingAlarmListener();
  updateDateTime();
  setInterval(updateDateTime, 1000);
  loadDailyStats();
  loadRecords();
  loadAlarms();
  initChart();
  requestAnimationFrame(renderLoop);
}

function setupEventListeners() {
  document.getElementById('connectBtn').addEventListener('click', toggleConnection);
  document.getElementById('refreshPortsBtn').addEventListener('click', refreshPorts);
  document.getElementById('refreshRecordsBtn').addEventListener('click', loadRecords);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChartType = btn.dataset.chart;
      bgDirty = true;
      chartDirty = true;
    });
  });

  refreshPorts();

  document.getElementById('agingAlarmAckBtn').addEventListener('click', handleAgingAlarmAck);
}

function setupSocketUpdateListener() {
  window.electronAPI.onSocketUpdate((updatedSockets) => {
    updatedSockets.forEach(updated => {
      const existing = sockets.find(s => s.id === updated.id);
      if (existing) {
        Object.assign(existing, updated);
      }
    });

    historyDirty = true;
    chartDirty = true;
    statsDirty = true;
    updateSocketElements(updatedSockets);
    scheduleRender();
  });
}

function setupAgingAlarmListener() {
  window.electronAPI.onAgingAlarm((alarm) => {
    console.warn('收到电瓶老化告警:', alarm);
    agingAlarmQueue.push(alarm);
    updateSocketAgingWarning(alarm.socketId, true);
    if (!agingAlarmVisible) {
      showNextAgingAlarm();
    }
    loadDailyStats();
    loadAlarms();
  });
}

function showNextAgingAlarm() {
  if (agingAlarmQueue.length === 0) {
    hideAgingAlarm();
    return;
  }

  const alarm = agingAlarmQueue.shift();
  showAgingAlarmModal(alarm);
}

function showAgingAlarmModal(alarm) {
  agingAlarmVisible = true;

  document.getElementById('agingAlarmSocket').textContent = '插座 #' + alarm.socketId;
  document.getElementById('agingAlarmMessage').textContent = alarm.message;
  document.getElementById('agingVolatility').textContent = (alarm.volatility * 100).toFixed(1) + '%';
  document.getElementById('agingPower').textContent = alarm.power.toFixed(0) + 'W';
  document.getElementById('agingTemp').textContent = alarm.temperature.toFixed(1) + '°C';

  document.getElementById('agingAlarmOverlay').classList.add('show');

  try {
    if (navigator.vibrate) {
      navigator.vibrate(200);
    }
  } catch (e) {}
}

function hideAgingAlarm() {
  agingAlarmVisible = false;
  document.getElementById('agingAlarmOverlay').classList.remove('show');
}

async function handleAgingAlarmAck() {
  const socketText = document.getElementById('agingAlarmSocket').textContent;
  const socketId = parseInt(socketText.replace(/\D/g, ''));

  try {
    await window.electronAPI.acknowledgeAgingAlarm(socketId);
  } catch (e) {
    console.error('确认告警失败:', e);
  }

  updateSocketAgingWarning(socketId, false);

  if (agingAlarmQueue.length > 0) {
    showNextAgingAlarm();
  } else {
    hideAgingAlarm();
  }
}

function updateSocketAgingWarning(socketId, show) {
  const el = socketElements[socketId];
  if (!el || !el.card) return;

  if (show) {
    el.card.classList.add('aging-warning');
  } else {
    el.card.classList.remove('aging-warning');
  }
}

function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
}

function renderLoop() {
  if (pendingRender) {
    pendingRender = false;
    if (historyDirty) {
      updateHistory();
      historyDirty = false;
    }
    if (statsDirty) {
      updateStats();
      statsDirty = false;
    }
    if (chartDirty) {
      drawChart();
      chartDirty = false;
    }
  }
  requestAnimationFrame(renderLoop);
}

async function loadSockets() {
  sockets = await window.electronAPI.getSockets();
  initHistory();
  createSocketElements();
  renderLegend();
  bgDirty = true;
  chartDirty = true;
  statsDirty = true;
}

function initHistory() {
  sockets.forEach(s => {
    powerHistory[s.id] = [];
  });
}

function updateHistory() {
  sockets.forEach(s => {
    if (!powerHistory[s.id]) {
      powerHistory[s.id] = [];
    }
    powerHistory[s.id].push({
      time: Date.now(),
      voltage: s.voltage,
      current: s.current,
      power: s.power
    });

    if (powerHistory[s.id].length > MAX_HISTORY) {
      powerHistory[s.id].shift();
    }
  });
}

function createSocketElements() {
  const grid = document.getElementById('socketsGrid');
  grid.innerHTML = '';
  socketElements = {};

  sockets.forEach(socket => {
    const card = document.createElement('div');
    card.className = 'socket-card ' + socket.status;
    card.dataset.id = socket.id;
    card.innerHTML = `
      <div class="socket-header">
        <span class="socket-id">插座 #${socket.id}</span>
        <span class="socket-status ${socket.status}">${getStatusText(socket.status)}</span>
      </div>
      <div class="socket-metrics">
        <div class="metric">
          <div class="metric-label">电压</div>
          <div class="metric-value voltage-val">${socket.voltage.toFixed(1)}V</div>
        </div>
        <div class="metric">
          <div class="metric-label">电流</div>
          <div class="metric-value current-val">${socket.current.toFixed(2)}A</div>
        </div>
        <div class="metric">
          <div class="metric-label">功率</div>
          <div class="metric-value power power-val">${(socket.power / 1000).toFixed(2)}kW</div>
        </div>
        <div class="metric">
          <div class="metric-label">温度</div>
          <div class="metric-value temp temp-val">${socket.temperature.toFixed(1)}°C</div>
        </div>
      </div>
      <div class="socket-actions">
        <button class="socket-btn start start-btn" data-id="${socket.id}" 
          ${socket.status !== 'idle' ? 'disabled' : ''}
          onclick="handleStartCharging(${socket.id})">
          开始充电
        </button>
        <button class="socket-btn stop stop-btn" data-id="${socket.id}"
          ${socket.status !== 'charging' ? 'disabled' : ''}
          onclick="handleStopCharging(${socket.id})">
          停止充电
        </button>
      </div>
    `;
    grid.appendChild(card);
    socketElements[socket.id] = {
      card,
      statusEl: card.querySelector('.socket-status'),
      voltageEl: card.querySelector('.voltage-val'),
      currentEl: card.querySelector('.current-val'),
      powerEl: card.querySelector('.power-val'),
      tempEl: card.querySelector('.temp-val'),
      startBtn: card.querySelector('.start-btn'),
      stopBtn: card.querySelector('.stop-btn'),
      lastStatus: socket.status,
      lastVoltage: socket.voltage,
      lastCurrent: socket.current,
      lastPower: socket.power,
      lastTemp: socket.temperature
    };
  });
}

function updateSocketElements(updatedSockets) {
  updatedSockets.forEach(socket => {
    const el = socketElements[socket.id];
    if (!el) return;

    if (el.lastStatus !== socket.status) {
      el.card.className = 'socket-card ' + socket.status;
      el.statusEl.className = 'socket-status ' + socket.status;
      el.statusEl.textContent = getStatusText(socket.status);
      el.lastStatus = socket.status;
      el.startBtn.disabled = socket.status !== 'idle';
      el.stopBtn.disabled = socket.status !== 'charging';
    }

    if (Math.abs(el.lastVoltage - socket.voltage) > 0.1) {
      el.voltageEl.textContent = socket.voltage.toFixed(1) + 'V';
      el.lastVoltage = socket.voltage;
    }

    if (Math.abs(el.lastCurrent - socket.current) > 0.01) {
      el.currentEl.textContent = socket.current.toFixed(2) + 'A';
      el.lastCurrent = socket.current;
    }

    if (Math.abs(el.lastPower - socket.power) > 1) {
      el.powerEl.textContent = (socket.power / 1000).toFixed(2) + 'kW';
      el.lastPower = socket.power;
    }

    if (Math.abs(el.lastTemp - socket.temperature) > 0.1) {
      el.tempEl.textContent = socket.temperature.toFixed(1) + '°C';
      el.lastTemp = socket.temperature;
    }
  });
}

function getStatusText(status) {
  const statusMap = {
    'idle': '空闲',
    'charging': '充电中',
    'alarm': '告警'
  };
  return statusMap[status] || status;
}

function updateStats() {
  const chargingCount = sockets.filter(s => s.status === 'charging').length;
  const el = document.getElementById('totalCharging');
  if (el.textContent !== String(chargingCount)) {
    el.textContent = chargingCount;
  }
}

async function handleStartCharging(socketId) {
  const result = await window.electronAPI.startCharging(socketId);
  if (result.success) {
    loadDailyStats();
  } else {
    alert('启动失败: ' + (result.error || '未知错误'));
  }
}

async function handleStopCharging(socketId) {
  const result = await window.electronAPI.stopCharging(socketId);
  if (result.success) {
    loadRecords();
    loadDailyStats();
  } else {
    alert('停止失败: ' + (result.error || '未知错误'));
  }
}

function initChart() {
  const canvas = document.getElementById('powerChart');
  const container = canvas.parentElement;

  const resizeObserver = new ResizeObserver(() => {
    const rect = container.getBoundingClientRect();
    chartWidth = rect.width;
    chartHeight = rect.height - 40;

    canvas.width = chartWidth * window.devicePixelRatio;
    canvas.height = chartHeight * window.devicePixelRatio;
    canvas.style.width = chartWidth + 'px';
    canvas.style.height = chartHeight + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    bgCanvas = document.createElement('canvas');
    bgCanvas.width = chartWidth * window.devicePixelRatio;
    bgCanvas.height = chartHeight * window.devicePixelRatio;
    bgCtx = bgCanvas.getContext('2d');
    bgCtx.scale(window.devicePixelRatio, window.devicePixelRatio);

    bgDirty = true;
    chartDirty = true;
  });

  resizeObserver.observe(container);
}

function drawBackground() {
  if (!bgCtx) return;

  bgCtx.clearRect(0, 0, chartWidth, chartHeight);

  bgCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  bgCtx.lineWidth = 1;

  const innerWidth = chartWidth - chartPadding.left - chartPadding.right;
  const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;

  for (let i = 0; i <= 5; i++) {
    const y = chartPadding.top + (innerHeight / 5) * i;
    bgCtx.beginPath();
    bgCtx.moveTo(chartPadding.left, y);
    bgCtx.lineTo(chartWidth - chartPadding.right, y);
    bgCtx.stroke();
  }

  for (let i = 0; i <= 6; i++) {
    const x = chartPadding.left + (innerWidth / 6) * i;
    bgCtx.beginPath();
    bgCtx.moveTo(x, chartPadding.top);
    bgCtx.lineTo(x, chartHeight - chartPadding.bottom);
    bgCtx.stroke();
  }

  bgCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  bgCtx.font = '10px sans-serif';
  bgCtx.textAlign = 'right';

  for (let i = 0; i <= 5; i++) {
    const y = chartPadding.top + (innerHeight / 5) * i;
    const value = lastMaxValue - ((lastMaxValue - lastMinValue) / 5) * i;
    bgCtx.fillText(value.toFixed(0), chartPadding.left - 8, y + 3);
  }

  bgCtx.textAlign = 'center';
  const timeLabels = ['-120s', '-100s', '-80s', '-60s', '-40s', '-20s', '现在'];
  for (let i = 0; i <= 6; i++) {
    const x = chartPadding.left + (innerWidth / 6) * i;
    bgCtx.fillText(timeLabels[i], x, chartHeight - chartPadding.bottom + 16);
  }

  bgCtx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  bgCtx.font = '11px sans-serif';
  bgCtx.textAlign = 'left';
  let unit = '';
  if (currentChartType === 'power') unit = 'W';
  else if (currentChartType === 'voltage') unit = 'V';
  else if (currentChartType === 'current') unit = 'A';
  bgCtx.fillText('单位: ' + unit, chartPadding.left, chartPadding.top - 8);

  bgDirty = false;
}

function downsample(data, maxPoints) {
  if (data.length <= maxPoints) return data;

  const sampled = [];
  const step = data.length / maxPoints;

  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let min = Infinity;
    let max = -Infinity;

    for (let j = start; j < end && j < data.length; j++) {
      let val;
      if (currentChartType === 'power') val = data[j].power;
      else if (currentChartType === 'voltage') val = data[j].voltage;
      else if (currentChartType === 'current') val = data[j].current;

      if (val < min) min = val;
      if (val > max) max = val;
    }

    const midIdx = Math.floor((start + end) / 2);
    sampled.push(data[midIdx] || data[start]);
  }

  return sampled;
}

function drawChart() {
  const canvas = document.getElementById('powerChart');
  const ctx = canvas.getContext('2d');
  if (!ctx || !bgCanvas) return;

  const innerWidth = chartWidth - chartPadding.left - chartPadding.right;
  const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) return;

  let maxValue = 0;
  let minValue = Infinity;

  const activeSockets = sockets.filter(s => s.status === 'charging');

  activeSockets.forEach(s => {
    const history = powerHistory[s.id] || [];
    history.forEach(h => {
      let val;
      if (currentChartType === 'power') val = h.power;
      else if (currentChartType === 'voltage') val = h.voltage;
      else if (currentChartType === 'current') val = h.current;

      if (val > maxValue) maxValue = val;
      if (val < minValue) minValue = val;
    });
  });

  if (maxValue === 0) {
    if (currentChartType === 'power') maxValue = 5000;
    else if (currentChartType === 'voltage') maxValue = 250;
    else if (currentChartType === 'current') maxValue = 10;
  }

  maxValue = maxValue * 1.1;
  if (minValue === Infinity) minValue = 0;
  minValue = minValue * 0.9;

  if (Math.abs(maxValue - lastMaxValue) > (maxValue * 0.02) ||
      Math.abs(minValue - lastMinValue) > (maxValue * 0.02)) {
    lastMaxValue = maxValue;
    lastMinValue = minValue;
    bgDirty = true;
  }

  if (bgDirty) {
    drawBackground();
  }

  ctx.clearRect(0, 0, chartWidth, chartHeight);
  ctx.drawImage(bgCanvas, 0, 0, chartWidth * window.devicePixelRatio, chartHeight * window.devicePixelRatio,
                          0, 0, chartWidth, chartHeight);

  const maxPoints = Math.min(300, Math.floor(innerWidth / 2));

  activeSockets.forEach((socket) => {
    const history = powerHistory[socket.id] || [];
    if (history.length < 2) return;

    const color = SOCKET_COLORS[(socket.id - 1) % SOCKET_COLORS.length];
    const sampled = downsample(history, maxPoints);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    sampled.forEach((h, i) => {
      let val;
      if (currentChartType === 'power') val = h.power;
      else if (currentChartType === 'voltage') val = h.voltage;
      else if (currentChartType === 'current') val = h.current;

      const x = chartPadding.left + (i / (sampled.length - 1)) * innerWidth;
      const y = chartPadding.top + innerHeight - ((val - minValue) / (maxValue - minValue)) * innerHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, chartPadding.top, 0, chartHeight - chartPadding.bottom);
    gradient.addColorStop(0, color + '25');
    gradient.addColorStop(1, color + '00');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    sampled.forEach((h, i) => {
      let val;
      if (currentChartType === 'power') val = h.power;
      else if (currentChartType === 'voltage') val = h.voltage;
      else if (currentChartType === 'current') val = h.current;

      const x = chartPadding.left + (i / (sampled.length - 1)) * innerWidth;
      const y = chartPadding.top + innerHeight - ((val - minValue) / (maxValue - minValue)) * innerHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.lineTo(chartPadding.left + ((sampled.length - 1) / (sampled.length - 1)) * innerWidth, chartHeight - chartPadding.bottom);
    ctx.lineTo(chartPadding.left, chartHeight - chartPadding.bottom);
    ctx.closePath();
    ctx.fill();
  });
}

function renderLegend() {
  const legend = document.getElementById('chartLegend');
  legend.innerHTML = '';

  sockets.forEach(s => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const color = SOCKET_COLORS[(s.id - 1) % SOCKET_COLORS.length];
    item.innerHTML = `
      <span class="legend-color" style="background: ${color}"></span>
      <span>插座${s.id}</span>
    `;
    legend.appendChild(item);
  });
}

async function refreshPorts() {
  const ports = await window.electronAPI.getSerialPorts();
  const select = document.getElementById('portSelect');
  select.innerHTML = '<option value="">选择串口...</option>';
  ports.forEach(port => {
    const option = document.createElement('option');
    option.value = port.path;
    option.textContent = port.path + ' - ' + port.manufacturer;
    select.appendChild(option);
  });
}

async function toggleConnection() {
  const btn = document.getElementById('connectBtn');
  const select = document.getElementById('portSelect');

  if (isConnected) {
    await window.electronAPI.disconnectSerial();
    isConnected = false;
    btn.textContent = '连接';
    updateSerialStatus(false);
  } else {
    if (!select.value) {
      alert('请选择串口');
      return;
    }
    const result = await window.electronAPI.connectSerial(select.value, 9600);
    if (result.success) {
      isConnected = true;
      btn.textContent = '断开';
      updateSerialStatus(true);
    } else {
      alert('连接失败: ' + (result.error || '未知错误'));
    }
  }
}

function updateSerialStatus(connected) {
  const dot = document.getElementById('serialStatus');
  const text = document.getElementById('serialStatusText');

  if (connected) {
    dot.classList.add('connected');
    text.textContent = '已连接';
  } else {
    dot.classList.remove('connected');
    text.textContent = '未连接';
  }
}

function updateDateTime() {
  const now = new Date();
  const str = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');
  document.getElementById('currentTime').textContent = str;
}

async function loadDailyStats() {
  const stats = await window.electronAPI.getDailyStats();
  document.getElementById('todayEnergy').textContent = stats.totalEnergy.toFixed(2);
  document.getElementById('todayCount').textContent = stats.totalCount;
  document.getElementById('todayAlarms').textContent = stats.alarms;
  document.getElementById('alarmBadge').textContent = stats.alarms;
}

async function loadRecords() {
  const data = await window.electronAPI.getChargingRecords(1, 10);
  const tbody = document.getElementById('recordsBody');
  tbody.innerHTML = '';

  if (data.records && data.records.length > 0) {
    data.records.forEach(record => {
      const tr = document.createElement('tr');
      const startTime = new Date(record.start_time).toLocaleString('zh-CN');
      const endTime = record.end_time ? new Date(record.end_time).toLocaleString('zh-CN') : '-';
      const duration = record.duration ? (record.duration * 60).toFixed(0) + '分钟' : '-';
      const statusText = record.status === 'charging' ? '充电中' : '已完成';
      const statusClass = record.status;

      tr.innerHTML = `
        <td>#${record.socket_id}</td>
        <td>${startTime}</td>
        <td>${endTime}</td>
        <td>${record.energy.toFixed(2)}</td>
        <td>${duration}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      `;
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#555;padding:30px;">暂无记录</td></tr>';
  }
}

async function loadAlarms() {
  const data = await window.electronAPI.getAlarmLogs(1, 10);
  const list = document.getElementById('alarmList');
  list.innerHTML = '';

  if (data.logs && data.logs.length > 0) {
    data.logs.forEach(log => {
      const item = document.createElement('div');
      item.className = 'alarm-item';
      const time = new Date(log.timestamp).toLocaleString('zh-CN');
      item.innerHTML = `
        <div class="alarm-header">
          <span class="alarm-socket">插座 #${log.socket_id}</span>
          <span class="alarm-time">${time}</span>
        </div>
        <div class="alarm-msg">${log.message}</div>
      `;
      list.appendChild(item);
    });
  } else {
    list.innerHTML = '<div class="empty-state">暂无告警记录</div>';
  }
}

window.addEventListener('DOMContentLoaded', init);
