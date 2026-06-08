const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

class SerialManager extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.isOpen = false;
  }

  async listPorts() {
    try {
      const ports = await SerialPort.list();
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '未知',
        serialNumber: p.serialNumber || '',
        vendorId: p.vendorId || '',
        productId: p.productId || ''
      }));
    } catch (error) {
      console.error('列出串口失败:', error);
      return [];
    }
  }

  connect(path, baudRate = 9600) {
    return new Promise((resolve, reject) => {
      if (this.isOpen) {
        return reject(new Error('串口已连接'));
      }

      this.port = new SerialPort({
        path,
        baudRate,
        autoOpen: false
      });

      this.port.on('open', () => {
        this.isOpen = true;
        console.log('串口已打开:', path);
        resolve();
      });

      this.port.on('data', (data) => {
        this.emit('data', data);
      });

      this.port.on('error', (error) => {
        console.error('串口错误:', error);
        this.emit('error', error);
        if (!this.isOpen) {
          reject(error);
        }
      });

      this.port.on('close', () => {
        this.isOpen = false;
        console.log('串口已关闭');
        this.emit('close');
      });

      this.port.open((err) => {
        if (err) {
          reject(err);
        }
      });
    });
  }

  disconnect() {
    return new Promise((resolve) => {
      if (this.port && this.isOpen) {
        this.port.close(() => {
          this.isOpen = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  send(data) {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.isOpen) {
        return reject(new Error('串口未连接'));
      }
      this.port.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  isConnected() {
    return this.isOpen;
  }
}

module.exports = SerialManager;
