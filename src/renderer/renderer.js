let sockets = [];
let powerHistory = {};
let currentChartType = 'power';
let isConnected = false;
const MAX_HISTORY = 60;
const SOCKET_COLORS = [
  '#00d4ff', '#00ff88', '#ff6b6b', '#ffb84d',
  '#7b2cbf', '#ff6b9d', '#4ecdc4', '#ffe66d',
  '#95e1d3', '#f38181', '#aa96da', '#fcbad3'
];

function init() {
  loadSockets();
  setupEventListeners();
  setupSocketUpdateListener();
  updateDateTime();
  setInterval(updateDateTime, 1000);
  loadDailyStats();
  loadRecords();
  loadAlarms();
  initChart();
  drawChart();
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
      drawChart();
    });
  });

  refreshPorts();
}

function setupSocketUpdateListener() {
  window.electronAPI.onSocketUpdate((updatedSockets) => {
    sockets = updatedSockets;
    renderSockets();
    updateStats();
    updateHistory();
    drawChart();
  });
}

async function loadSockets() {
  sockets = await window.electronAPI.getSockets();
  renderSockets();
  initHistory();
  drawChart();
  renderLegend();
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
    let value = 0;
    if (currentChartType === 'power') value = s.power;
    else if (currentChartType === 'voltage') value = s.voltage;
    else if (currentChartType === 'current') value = s.current;

    powerHistory[s.id].push({
      time: Date.now(),
      value: value,
      voltage: s.voltage,
      current: s.current,
      power: s.power
    });

    if (powerHistory[s.id].length > MAX_HISTORY) {
      powerHistory[s.id].shift();
    }
  });
}

function renderSockets() {
  const grid = document.getElementById('socketsGrid');
  grid.innerHTML = '';

  sockets.forEach(socket => {
    const card = document.createElement('div');
    card.className = `socket-card ${socket.status}`;
    card.innerHTML = `
      <div class="socket-header">
        <span class="socket-id">插座 #${socket.id}</span>
        <span class="socket-status ${socket.status}">${getStatusText(socket.status)}</span>
      </div>
      <div class="socket-metrics">
        <div class="metric">
          <div class="metric-label">电压</div>
          <div class="metric-value">${socket.voltage.toFixed(1)}V</div>
        </div>
        <div class="metric">
          <div class="metric-label">电流</div>
          <div class="metric-value">${socket.current.toFixed(2)}A</div>
        </div>
        <div class="metric">
          <div class="metric-label">功率</div>
          <div class="metric-value power">${(socket.power / 1000).toFixed(2)}kW</div>
        </div>
        <div class="metric">
          <div class="metric-label">温度</div>
          <div class="metric-value temp">${socket.temperature.toFixed(1)}°C</div>
        </div>
      </div>
      <div class="socket-actions">
        <button class="socket-btn start" data-id="${socket.id}" 
          ${socket.status !== 'idle' ? 'disabled' : ''}
          onclick="handleStartCharging(${socket.id})">
          开始充电
        </button>
        <button class="socket-btn stop" data-id="${socket.id}"
          ${socket.status !== 'charging' ? 'disabled' : ''}
          onclick="handleStopCharging(${socket.id})">
          停止充电
        </button>
      </div>
    `;
    grid.appendChild(card);
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
  document.getElementById('totalCharging').textContent = chargingCount;
}

async function handleStartCharging(socketId) {
  const result = await window.electronAPI.startCharging(socketId);
  if (result.success) {
    loadSockets();
    loadDailyStats();
  } else {
    alert('启动失败: ' + (result.error || '未知错误'));
  }
}

async function handleStopCharging(socketId) {
  const result = await window.electronAPI.stopCharging(socketId);
  if (result.success) {
    loadSockets();
    loadRecords();
    loadDailyStats();
  } else {
    alert('停止失败: ' + (result.error || '未知错误'));
  }
}

function initChart() {
  const canvas = document.getElementById('powerChart');
  const resizeObserver = new ResizeObserver(() => {
    drawChart();
  });
  resizeObserver.observe(canvas.parentElement);
}

function drawChart() {
  const canvas = document.getElementById('powerChart');
  const ctx = canvas.getContext('2d');
  const container = canvas.parentElement;

  canvas.width = container.clientWidth * window.devicePixelRatio;
  canvas.height = (container.clientHeight - 40) * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const width = container.clientWidth;
  const height = container.clientHeight - 40;
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;

  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  for (let i = 0; i <= 6; i++) {
    const x = padding.left + (chartWidth / 6) * i;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
  }

  let maxValue = 0;
  let minValue = Infinity;

  sockets.forEach(s => {
    const history = powerHistory[s.id] || [];
    history.forEach(h => {
      let val = 0;
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

  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartHeight / 5) * i;
    const value = maxValue - ((maxValue - minValue) / 5) * i;
    ctx.fillText(value.toFixed(0), padding.left - 8, y + 3);
  }

  ctx.textAlign = 'center';
  const timeLabels = ['-60s', '-50s', '-40s', '-30s', '-20s', '-10s', '现在'];
  for (let i = 0; i <= 6; i++) {
    const x = padding.left + (chartWidth / 6) * i;
    ctx.fillText(timeLabels[i], x, height - padding.bottom + 16);
  }

  const activeSockets = sockets.filter(s => s.status === 'charging');

  activeSockets.forEach((socket, index) => {
    const history = powerHistory[socket.id] || [];
    if (history.length < 2) return;

    const color = SOCKET_COLORS[(socket.id - 1) % SOCKET_COLORS.length];

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    history.forEach((h, i) => {
      let val = 0;
      if (currentChartType === 'power') val = h.power;
      else if (currentChartType === 'voltage') val = h.voltage;
      else if (currentChartType === 'current') val = h.current;

      const x = padding.left + (i / (MAX_HISTORY - 1)) * chartWidth;
      const y = padding.top + chartHeight - ((val - minValue) / (maxValue - minValue)) * chartHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, color + '30');
    gradient.addColorStop(1, color + '00');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    history.forEach((h, i) => {
      let val = 0;
      if (currentChartType === 'power') val = h.power;
      else if (currentChartType === 'voltage') val = h.voltage;
      else if (currentChartType === 'current') val = h.current;

      const x = padding.left + (i / (MAX_HISTORY - 1)) * chartWidth;
      const y = padding.top + chartHeight - ((val - minValue) / (maxValue - minValue)) * chartHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.lineTo(padding.left + (chartWidth * (history.length - 1) / (MAX_HISTORY - 1)), height - padding.bottom);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.closePath();
    ctx.fill();
  });

  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  let unit = '';
  if (currentChartType === 'power') unit = 'W';
  else if (currentChartType === 'voltage') unit = 'V';
  else if (currentChartType === 'current') unit = 'A';
  ctx.fillText('单位: ' + unit, padding.left, padding.top - 8);
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
    option.textContent = `${port.path} - ${port.manufacturer}`;
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
