'use strict';

/**
 * Kho lưu trữ trạng thái JSON dùng chung giữa các bản sao stateless (qua Docker shared volume).
 *
 * Đảm bảo tính nhất quán và kiểm soát đồng thời (concurrency control) mà không cần thư viện ngoài:
 *   1. Khóa độc quyền liên tiến trình (cross-process mutex) bằng thao tác nguyên tử `fs.mkdirSync(lockDir)`.
 *   2. Tự thu hồi khóa treo (stale lock) nếu một tiến trình bị crash giữa chừng khi đang giữ khóa.
 *   3. Ghi nguyên tử (atomic write) qua file tạm cùng thư mục rồi `fs.renameSync` đè lên file đích.
 */

const fs = require('node:fs');
const path = require('node:path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FileStore {
  constructor({
    filePath,
    initialData = {},
    lockTimeoutMs = 5000,
    retryDelayMs = 5,
    staleLockMs = 10000,
  } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockDir = `${this.filePath}.lock`;
    this.initialData = clone(initialData);
    this.lockTimeoutMs = lockTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.staleLockMs = staleLockMs;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  async _acquireLock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(this.lockDir);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) {
            fs.rmSync(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Lock vừa được giải phóng bởi tiến trình khác.
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`FileStore lock timeout on ${this.filePath}`);
        }
        await sleep(this.retryDelayMs + Math.floor(Math.random() * 5));
      }
    }
  }

  _releaseLock() {
    try {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  _readUnlocked() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return clone(this.initialData);
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return clone(this.initialData);
      throw err;
    }
  }

  _writeUnlocked(data) {
    const tmpFile = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, this.filePath);
  }

  async read() {
    await this._acquireLock();
    try {
      if (!fs.existsSync(this.filePath)) {
        const seed = clone(this.initialData);
        this._writeUnlocked(seed);
        return seed;
      }
      return this._readUnlocked();
    } finally {
      this._releaseLock();
    }
  }

  /**
   * Thực thi hàm cập nhật `mutator(state)` trong vùng khóa nguyên tử.
   * Mọi thay đổi trên `state` được ghi bền vững xuống đĩa trước khi nhả khóa.
   */
  async transact(mutator) {
    await this._acquireLock();
    try {
      const state = this._readUnlocked();
      const result = await mutator(state);
      this._writeUnlocked(state);
      return result;
    } finally {
      this._releaseLock();
    }
  }
}

module.exports = { FileStore };
