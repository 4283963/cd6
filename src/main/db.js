const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class ChargingDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.SQL = null;
  }

  async init() {
    this.SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      this.db = new this.SQL.Database();
    }
    this.createTables();
    this.ensureDirExists();
  }

  ensureDirExists() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  save() {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      this.ensureDirExists();
      fs.writeFileSync(this.dbPath, buffer);
    } catch (e) {
      console.error('保存数据库失败:', e);
    }
  }

  query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
    this.save();
  }

  createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS charging_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        socket_id INTEGER NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        energy REAL DEFAULT 0,
        duration REAL DEFAULT 0,
        status TEXT DEFAULT 'charging',
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS alarm_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        socket_id INTEGER NOT NULL,
        alarm_type TEXT NOT NULL,
        message TEXT,
        timestamp INTEGER NOT NULL,
        resolved INTEGER DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS power_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        socket_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        voltage REAL,
        current REAL,
        power REAL,
        temperature REAL
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_charging_socket ON charging_records(socket_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_alarm_socket ON alarm_logs(socket_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_power_socket_time ON power_history(socket_id, timestamp)');

    this.save();
  }

  startChargingRecord(socketId) {
    this.run(
      'INSERT INTO charging_records (socket_id, start_time, status) VALUES (?, ?, ?)',
      [socketId, Date.now(), 'charging']
    );
    const result = this.query('SELECT last_insert_rowid() as id');
    return result[0].id;
  }

  endChargingRecord(socketId, energy, duration) {
    this.run(
      `UPDATE charging_records
       SET end_time = ?, energy = ?, duration = ?, status = 'completed'
       WHERE id = (SELECT id FROM charging_records WHERE socket_id = ? AND status = 'charging' ORDER BY id DESC LIMIT 1)`,
      [Date.now(), energy, duration, socketId]
    );
  }

  getChargingRecords(page = 1, pageSize = 20) {
    const offset = (page - 1) * pageSize;

    const countResult = this.query('SELECT COUNT(*) as total FROM charging_records');
    const total = countResult[0].total;

    const records = this.query(
      'SELECT * FROM charging_records ORDER BY start_time DESC LIMIT ? OFFSET ?',
      [pageSize, offset]
    );

    return { records, total, page, pageSize };
  }

  addAlarmLog(socketId, alarmType, message) {
    this.run(
      'INSERT INTO alarm_logs (socket_id, alarm_type, message, timestamp) VALUES (?, ?, ?, ?)',
      [socketId, alarmType, message, Date.now()]
    );
    const result = this.query('SELECT last_insert_rowid() as id');
    return result[0].id;
  }

  getAlarmLogs(page = 1, pageSize = 20) {
    const offset = (page - 1) * pageSize;

    const countResult = this.query('SELECT COUNT(*) as total FROM alarm_logs');
    const total = countResult[0].total;

    const logs = this.query(
      'SELECT * FROM alarm_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      [pageSize, offset]
    );

    return { logs, total, page, pageSize };
  }

  addPowerHistory(socketId, voltage, current, power, temperature) {
    this.run(
      'INSERT INTO power_history (socket_id, timestamp, voltage, current, power, temperature) VALUES (?, ?, ?, ?, ?, ?)',
      [socketId, Date.now(), voltage, current, power, temperature]
    );
  }

  getPowerHistory(socketId, startTime, endTime) {
    return this.query(
      'SELECT * FROM power_history WHERE socket_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
      [socketId, startTime, endTime]
    );
  }

  getDailyStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    const energyResult = this.query(
      `SELECT COALESCE(SUM(energy), 0) as totalEnergy
       FROM charging_records
       WHERE start_time >= ? AND status = 'completed'`,
      [todayStart]
    );
    const totalEnergy = energyResult[0].totalEnergy;

    const countResult = this.query(
      'SELECT COUNT(*) as totalCount FROM charging_records WHERE start_time >= ?',
      [todayStart]
    );
    const totalCount = countResult[0].totalCount;

    const alarmResult = this.query(
      'SELECT COUNT(*) as alarms FROM alarm_logs WHERE timestamp >= ?',
      [todayStart]
    );
    const alarms = alarmResult[0].alarms;

    return {
      totalEnergy: Math.round(totalEnergy * 100) / 100,
      totalCount,
      alarms
    };
  }

  close() {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = ChargingDatabase;
