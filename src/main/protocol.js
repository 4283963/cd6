const { EventEmitter } = require('events');

class Protocol extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.FRAME_HEADER = 0xAA;
    this.FRAME_TAIL = 0x55;
  }

  parse(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames = [];

    while (this.buffer.length >= 8) {
      const headerIndex = this.buffer.indexOf(this.FRAME_HEADER);
      if (headerIndex === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      if (headerIndex > 0) {
        this.buffer = this.buffer.slice(headerIndex);
      }

      if (this.buffer.length < 8) {
        break;
      }

      const frameLen = this.buffer[2];
      if (this.buffer.length < frameLen + 4) {
        break;
      }

      if (this.buffer[frameLen + 3] === this.FRAME_TAIL) {
        const frame = this.buffer.slice(0, frameLen + 4);
        const checksum = this.calculateChecksum(frame.slice(1, frameLen + 2));
        if (checksum === frame[frameLen + 2]) {
          const parsed = this.parseFrame(frame);
          if (parsed) {
            frames.push(parsed);
          }
        }
        this.buffer = this.buffer.slice(frameLen + 4);
      } else {
        this.buffer = this.buffer.slice(1);
      }
    }

    return frames;
  }

  parseFrame(frame) {
    const cmd = frame[1];
    const dataLen = frame[2];
    const data = frame.slice(3, 3 + dataLen);

    switch (cmd) {
      case 0x01:
        return this.parseStatusData(data);
      case 0x02:
        return this.parseAlarmData(data);
      case 0x03:
        return { type: 'ack', success: data[0] === 0x00 };
      default:
        return null;
    }
  }

  parseStatusData(data) {
    if (data.length < 8) return null;

    const socketId = data[0];
    const status = data[1];
    const voltage = data.readUInt16BE(2) / 10;
    const current = data.readUInt16BE(4) / 100;
    const temperature = data.readInt16BE(6) / 10;

    let statusStr = 'idle';
    if (status === 0x01) statusStr = 'charging';
    if (status === 0x02) statusStr = 'alarm';
    if (status === 0x03) statusStr = 'fault';

    return {
      type: 'status',
      socketId,
      status: statusStr,
      voltage,
      current,
      power: voltage * current,
      temperature
    };
  }

  parseAlarmData(data) {
    if (data.length < 4) return null;

    const socketId = data[0];
    const alarmType = data[1];
    const alarmValue = data.readUInt16BE(2);

    let alarmTypeStr = 'unknown';
    let message = '';

    switch (alarmType) {
      case 0x01:
        alarmTypeStr = 'overvoltage';
        message = '过压报警: ' + (alarmValue / 10) + 'V';
        break;
      case 0x02:
        alarmTypeStr = 'overcurrent';
        message = '过流报警: ' + (alarmValue / 100) + 'A';
        break;
      case 0x03:
        alarmTypeStr = 'overheat';
        message = '过温报警: ' + (alarmValue / 10) + '°C';
        break;
      case 0x04:
        alarmTypeStr = 'short_circuit';
        message = '短路报警';
        break;
      case 0x05:
        alarmTypeStr = 'leakage';
        message = '漏电报警';
        break;
    }

    return {
      type: 'alarm',
      socketId,
      alarmType: alarmTypeStr,
      alarmValue,
      message
    };
  }

  buildStartCommand(socketId) {
    const data = Buffer.from([socketId]);
    return this.buildFrame(0x10, data);
  }

  buildStopCommand(socketId) {
    const data = Buffer.from([socketId]);
    return this.buildFrame(0x11, data);
  }

  buildQueryCommand(socketId) {
    const data = Buffer.from([socketId]);
    return this.buildFrame(0x12, data);
  }

  buildFrame(cmd, data) {
    const frame = Buffer.alloc(data.length + 4);
    frame[0] = this.FRAME_HEADER;
    frame[1] = cmd;
    frame[2] = data.length;
    data.copy(frame, 3);
    const checksum = this.calculateChecksum(frame.slice(1, data.length + 2));
    frame[data.length + 3] = this.FRAME_TAIL;
    frame[data.length + 2] = checksum;
    return frame;
  }

  calculateChecksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    return sum & 0xFF;
  }
}

module.exports = Protocol;
