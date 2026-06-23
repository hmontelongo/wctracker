function messageDataToString(data) {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.listeners = new Set();
    this.socket = null;
  }

  async connect(timeoutMs = 30000) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('This script requires Node.js with the global WebSocket API.');
    }

    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out while opening Scraping Browser WebSocket.'));
      }, timeoutMs);

      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });

      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Failed to open Scraping Browser WebSocket.'));
      }, { once: true });
    });
  }

  handleMessage(data) {
    const message = JSON.parse(messageDataToString(data));

    if (message.id && this.pending.has(message.id)) {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(request.timeout);

      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message}`));
      } else {
        request.resolve(message.result || {});
      }

      return;
    }

    for (const listener of this.listeners) {
      listener(message);
    }

    for (const waiter of [...this.waiters]) {
      if (
        waiter.method === message.method &&
        (!waiter.sessionId || waiter.sessionId === message.sessionId)
      ) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  onMessage(listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 45000) {
    const id = this.nextId++;
    const payload = { id, method, params };

    if (sessionId) {
      payload.sessionId = sessionId;
    }

    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out waiting for CDP response.`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timeout });
    });
  }

  waitFor(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        sessionId,
        resolve,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`${method}: timed out waiting for CDP event.`));
        }, timeoutMs),
      };

      this.waiters.add(waiter);
    });
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}

