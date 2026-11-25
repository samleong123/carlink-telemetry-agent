import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = process.pkg ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SPOOL_PATH = join(AGENT_DIR, '.telemetry-spool.json');

export function encodeRemainingLength(length) {
  const bytes = [];
  let n = length;
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    bytes.push(digit);
  } while (n > 0);
  return Buffer.from(bytes);
}

function encodeUtf8Field(str) {
  const data = Buffer.from(str, 'utf8');
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(data.length, 0);
  return Buffer.concat([len, data]);
}

function wrapMqttPacket(headerByte, body) {
  return Buffer.concat([Buffer.from([headerByte]), encodeRemainingLength(body.length), body]);
}

export function encodeConnect({ clientId, username, password, keepAlive = 30 }) {
  const varHeader = Buffer.from([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
    0x04,
    0xc2,
    (keepAlive >> 8) & 0xff,
    keepAlive & 0xff,
  ]);
  const payload = Buffer.concat([
    encodeUtf8Field(clientId),
    encodeUtf8Field(username),
    encodeUtf8Field(password),
  ]);
  return wrapMqttPacket(0x10, Buffer.concat([varHeader, payload]));
}

export function encodeSubscribe(packetId, subscriptions) {
  const idBuf = Buffer.allocUnsafe(2);
  idBuf.writeUInt16BE(packetId, 0);
  const parts = [idBuf];
  for (const { topic, qos = 1 } of subscriptions) {
    parts.push(encodeUtf8Field(topic), Buffer.from([qos & 0x03]));
  }
  return wrapMqttPacket(0x82, Buffer.concat(parts));
}

export function encodePublish({ topic, payload, packetId = 1, qos = 1, retain = false }) {
  const header = 0x30 | ((qos & 0x03) << 1) | (retain ? 1 : 0);
  const parts = [encodeUtf8Field(topic)];
  if (qos > 0) {
    const idBuf = Buffer.allocUnsafe(2);
    idBuf.writeUInt16BE(packetId, 0);
    parts.push(idBuf);
  }
  parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  return wrapMqttPacket(header, Buffer.concat(parts));
}

export function encodePuback(packetId) {
  const buf = Buffer.allocUnsafe(4);
  buf[0] = 0x40;
  buf[1] = 0x02;
  buf.writeUInt16BE(packetId, 2);
  return buf;
}

export function encodePingreq() {
  return Buffer.from([0xc0, 0x00]);
}

export function encodeDisconnect() {
  return Buffer.from([0xe0, 0x00]);
}

export function tryDecodePacket(buffer) {
  if (buffer.length < 2) return null;
  let multiplier = 1;
  let value = 0;
  let pos = 1;
  let encodedByte = 0;
  do {
    if (pos >= buffer.length) return null;
    encodedByte = buffer[pos++];
    value += (encodedByte & 0x7f) * multiplier;
    if (multiplier > 128 * 128 * 128) {
      throw new Error('Malformed MQTT Remaining Length.');
    }
    multiplier *= 128;
  } while ((encodedByte & 0x80) !== 0);

  const totalLength = pos + value;
  if (buffer.length < totalLength) return null;

  const firstByte = buffer[0];
  const type = (firstByte >> 4) & 0x0f;
  const flags = firstByte & 0x0f;
  const body = buffer.subarray(pos, totalLength);
  const rest = buffer.subarray(totalLength);

  if (type === 2 && body.length >= 2) {
    return {
      packet: { type: 'CONNACK', sessionPresent: (body[0] & 0x01) === 1, returnCode: body[1] },
      rest,
    };
  }
  if (type === 4 && body.length >= 2) {
    return { packet: { type: 'PUBACK', packetId: body.readUInt16BE(0) }, rest };
  }
  if (type === 9 && body.length >= 2) {
    return {
      packet: {
        type: 'SUBACK',
        packetId: body.readUInt16BE(0),
        returnCodes: [...body.subarray(2)],
      },
      rest,
    };
  }
  if (type === 13) {
    return { packet: { type: 'PINGRESP' }, rest };
  }
  if (type === 3) {
    if (body.length < 2) throw new Error('Malformed MQTT PUBLISH packet.');
    let idx = 0;
    const topicLen = body.readUInt16BE(idx);
    idx += 2;
    if (body.length < idx + topicLen) throw new Error('Truncated MQTT PUBLISH topic.');
    const topic = body.subarray(idx, idx + topicLen).toString('utf8');
    idx += topicLen;
    const qos = (flags >> 1) & 0x03;
    let packetId = null;
    if (qos > 0) {
      if (body.length < idx + 2) throw new Error('Truncated MQTT PUBLISH packetId.');
      packetId = body.readUInt16BE(idx);
      idx += 2;
    }
    const payload = body.subarray(idx).toString('utf8');
    return { packet: { type: 'PUBLISH', qos, packetId, topic, payload }, rest };
  }

  return { packet: { type: `TYPE_${type}`, flags, body }, rest };
}

const CONNACK_ERRORS = {
  1: 'Unacceptable protocol version',
  2: 'Identifier rejected',
  3: 'Broker server unavailable',
  4: 'Bad broker_username or auth_token',
  5: 'Not authorized (check RabbitMQ vhost/permissions/topic-permissions)',
};

function encodeWsFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '');
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;

  const mask = randomBytes(4);
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  mask.copy(frame, headerLen);
  for (let i = 0; i < len; i++) {
    frame[headerLen + 4 + i] = payload[i] ^ mask[i & 3];
  }
  return frame;
}

function tryDecodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) {
    for (let i = 0; i < len; i++) payload[i] ^= buf[maskOffset + (i & 3)];
  }
  return { fin, opcode, payload, rest: buf.subarray(offset + len) };
}

function openNodeWebSocket(url, caPem, onOpen, onBinary, onError, onClose, onPong) {
  const isSecure = url.protocol === 'wss:';
  const port = Number(url.port || (isSecure ? 443 : 80));
  const socket = isSecure
    ? tls.connect({
        host: url.hostname,
        port,
        servername: url.hostname,
        ...(caPem ? { ca: caPem } : {}),
      })
    : net.connect({ host: url.hostname, port });

  socket.setKeepAlive(true, 10_000);
  socket.setNoDelay(true);

  const wsKey = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1')
    .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  let upgraded = false;
  let closed = false;
  let recv = Buffer.alloc(0);
  let fragChunks = [];

  const emitCloseOnce = (code) => {
    if (closed) return;
    closed = true;
    onClose(code);
  };

  const connectEvent = isSecure ? 'secureConnect' : 'connect';
  socket.on(connectEvent, () => {
    const path = `${url.pathname || '/'}${url.search || ''}`;
    const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: mqtt\r\n\r\n`,
    );
  });

  socket.on('data', (chunk) => {
    recv = Buffer.concat([recv, chunk]);
    if (!upgraded) {
      const headerEnd = recv.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = recv.subarray(0, headerEnd).toString('latin1');
      recv = recv.subarray(headerEnd + 4);
      const statusLine = head.split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01]\s+101\b/i.test(statusLine)) {
        onError(new Error(`WebSocket upgrade failed: ${statusLine}`));
        socket.destroy();
        return;
      }
      const acceptMatch = /^sec-websocket-accept:\s*(.+)$/im.exec(head);
      if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
        onError(new Error('Invalid Sec-WebSocket-Accept header from broker'));
        socket.destroy();
        return;
      }
      upgraded = true;
      onOpen();
    }

    while (recv.length > 0) {
      const frame = tryDecodeWsFrame(recv);
      if (!frame) break;
      recv = frame.rest;
      if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        try {
          socket.end(encodeWsFrame(0x8, Buffer.alloc(0)));
        } catch {
          // Ignore
        }
        socket.destroy();
        emitCloseOnce(code);
        return;
      }
      if (frame.opcode === 0x9) {
        onPong?.();
        if (!socket.destroyed) socket.write(encodeWsFrame(0x0a, frame.payload));
        continue;
      }
      if (frame.opcode === 0x0a) {
        onPong?.();
        continue;
      }
      if (frame.opcode === 0x02 || frame.opcode === 0x01 || frame.opcode === 0x00) {
        fragChunks.push(frame.payload);
        if (frame.fin) {
          onBinary(Buffer.concat(fragChunks));
          fragChunks = [];
        }
      }
    }
  });

  socket.on('error', (err) => {
    onError(err);
    socket.destroy();
  });
  socket.on('close', () => emitCloseOnce(upgraded ? 1006 : 1002));

  return {
    send: (buf) => {
      if (!upgraded || socket.destroyed) {
        throw new Error('WebSocket is not open');
      }
      socket.write(encodeWsFrame(0x02, buf));
    },
    ping: () => {
      if (upgraded && !socket.destroyed) {
        socket.write(encodeWsFrame(0x09, Buffer.alloc(0)));
      }
    },
    close: () => {
      try {
        if (upgraded && !socket.destroyed) socket.write(encodeWsFrame(0x08, Buffer.alloc(0)));
      } catch {
        // Ignore
      }
      socket.destroy();
      emitCloseOnce(1000);
    },
  };
}

export class MinimalMqttClient {
  constructor(urlString, { clientId, username, password, caPem = null, keepAlive = 20 }) {
    this.url = new URL(urlString);
    this.clientId = clientId;
    this.username = username;
    this.password = password;
    this.caPem = caPem;
    this.keepAlive = keepAlive;
    this.nextPacketId = 1;
    this.recvBuf = Buffer.alloc(0);
    this.sendRaw = null;
    this.pingRaw = null;
    this.closeRaw = null;
    this.pingTimer = null;
    this.lastInboundAt = Date.now();
    this.pendingPubacks = new Map();
    this.closed = false;
    this.handlers = { message: [], close: [], error: [], puback: [], suback: [], pingresp: [] };
  }

  on(event, fn) {
    this.handlers[event]?.push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }

  allocPacketId() {
    const id = this.nextPacketId;
    this.nextPacketId = id >= 65535 ? 1 : id + 1;
    return id;
  }

  async connect() {
    let settled = false;
    let settleConnect;
    let rejectConnect;
    const connected = new Promise((res, rej) => {
      settleConnect = (val) => {
        if (settled) return;
        settled = true;
        res(val);
      };
      rejectConnect = (err) => {
        if (settled) return;
        settled = true;
        rej(err);
      };
    });

    const handleChunk = (chunk) => {
      this.lastInboundAt = Date.now();
      this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
      while (true) {
        let decoded;
        try {
          decoded = tryDecodePacket(this.recvBuf);
        } catch (err) {
          this.emit('error', err);
          return;
        }
        if (!decoded) break;
        this.recvBuf = decoded.rest;
        const { packet } = decoded;
        if (packet.type === 'CONNACK') {
          if (packet.returnCode === 0) {
            this.lastInboundAt = Date.now();
            this.startKeepAlive();
            settleConnect();
          } else {
            const detail = CONNACK_ERRORS[packet.returnCode] || `CONNACK code ${packet.returnCode}`;
            rejectConnect(new Error(`MQTT authentication failed: ${detail}`));
          }
        } else if (packet.type === 'PUBLISH') {
          if (packet.qos === 1 && packet.packetId !== null) {
            try {
              this.sendRaw?.(encodePuback(packet.packetId));
            } catch {
              // Ignore
            }
          }
          this.emit('message', packet.topic, packet.payload);
        } else if (packet.type === 'PUBACK') {
          this.pendingPubacks.delete(packet.packetId);
          this.emit('puback', packet.packetId);
        } else if (packet.type === 'PINGRESP') {
          this.emit('pingresp');
        } else if (packet.type === 'SUBACK') {
          if (packet.returnCodes.some((c) => c === 0x80)) {
            this.emit('error', new Error('Broker rejected topic subscription (ACL failure / 0x80).'));
          } else {
            this.emit('suback', packet);
          }
        }
      }
    };

    const connectPayload = encodeConnect({
      clientId: this.clientId,
      username: this.username,
      password: this.password,
      keepAlive: this.keepAlive,
    });

    if (this.url.protocol === 'wss:' || this.url.protocol === 'ws:') {
      const rawWs = openNodeWebSocket(
        this.url,
        this.caPem,
        () => {
          try {
            this.sendRaw(connectPayload);
          } catch (err) {
            rejectConnect(err);
          }
        },
        handleChunk,
        (err) => {
          rejectConnect(err);
          this.emit('error', err);
        },
        (code) => {
          this.stopKeepAlive();
          rejectConnect(new Error(`WebSocket closed before CONNACK (code ${code})`));
          if (!this.closed) {
            this.closed = true;
            this.emit('close', code);
          }
        },
        () => {
          this.lastInboundAt = Date.now();
        },
      );
      this.sendRaw = rawWs.send;
      this.pingRaw = rawWs.ping;
      this.closeRaw = rawWs.close;
    } else if (this.url.protocol === 'mqtts:') {
      const socket = tls.connect({
        host: this.url.hostname,
        port: Number(this.url.port || 8883),
        servername: this.url.hostname,
        ...(this.caPem ? { ca: this.caPem } : {}),
      });
      socket.setKeepAlive(true, 10_000);
      socket.setNoDelay(true);
      this.sendRaw = (buf) => {
        if (socket.destroyed) throw new Error('TLS socket is closed');
        socket.write(buf);
      };
      this.closeRaw = () => socket.destroy();
      socket.on('secureConnect', () => this.sendRaw(connectPayload));
      socket.on('data', handleChunk);
      socket.on('error', (err) => {
        rejectConnect(err);
        this.emit('error', err);
        socket.destroy();
      });
      socket.on('close', () => {
        this.stopKeepAlive();
        rejectConnect(new Error('TLS socket closed before CONNACK'));
        if (!this.closed) {
          this.closed = true;
          this.emit('close');
        }
      });
    } else {
      throw new Error(`Unsupported broker protocol: ${this.url.protocol}`);
    }

    const timeout = setTimeout(() => {
      rejectConnect(new Error('MQTT CONNACK timeout after 12s'));
      this.disconnect();
    }, 12_000);
    timeout.unref?.();
    try {
      await connected;
    } catch (err) {
      this.disconnect();
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const silenceMs = now - this.lastInboundAt;
      let pubackTimedOut = false;
      for (const sentAt of this.pendingPubacks.values()) {
        if (now - sentAt > 12_000) {
          pubackTimedOut = true;
          break;
        }
      }
      if (silenceMs > 22_000 || pubackTimedOut) {
        this.emit(
          'error',
          new Error(
            pubackTimedOut
              ? 'MQTT QoS 1 PUBACK timeout (network disconnected)'
              : `MQTT keepalive timeout after ${Math.round(silenceMs / 1000)}s silence`,
          ),
        );
        this.disconnect();
        return;
      }
      try {
        this.sendRaw?.(encodePingreq());
        this.pingRaw?.();
      } catch (err) {
        this.emit('error', err);
        this.disconnect();
      }
    }, 5000);
    this.pingTimer.unref?.();
  }

  stopKeepAlive() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  subscribe(topics) {
    const packetId = this.allocPacketId();
    const subs = topics.map((topic) => ({ topic, qos: 1 }));
    this.sendRaw(encodeSubscribe(packetId, subs));
    return packetId;
  }

  publish(topic, payload) {
    const packetId = this.allocPacketId();
    this.pendingPubacks.set(packetId, Date.now());
    this.sendRaw(encodePublish({ topic, payload, packetId, qos: 1, retain: false }));
    return packetId;
  }

  disconnect() {
    this.stopKeepAlive();
    this.pendingPubacks.clear();
    this.recvBuf = Buffer.alloc(0);
    try {
      this.closeRaw?.();
    } catch {
      // Ignore shutdown errors
    }
    if (!this.closed) {
      this.closed = true;
      this.emit('close', 1000);
    }
    for (const key of Object.keys(this.handlers)) {
      this.handlers[key] = [];
    }
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function loadLocalSpool(spoolPath = DEFAULT_SPOOL_PATH) {
  try {
    if (!existsSync(spoolPath)) return [];
    const parsed = JSON.parse(readFileSync(spoolPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.eventId === 'string' &&
          typeof item.wireJson === 'string' &&
          now - (Number(item.createdAt) || now) < SEVEN_DAYS_MS,
      )
      .map((item) => ({
        eventId: item.eventId,
        wireJson: item.wireJson,
        createdAt: Number(item.createdAt) || now,
        lastSentAt: 0,
        attempts: Number(item.attempts) || 0,
      }));
  } catch {
    return [];
  }
}

export function saveLocalSpool(records, spoolPath = DEFAULT_SPOOL_PATH) {
  try {
    const dir = dirname(resolve(spoolPath));
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${spoolPath}.tmp-${process.pid}`;
    const serializable = records.map((r) => ({
      eventId: r.eventId,
      wireJson: r.wireJson,
      createdAt: r.createdAt,
      attempts: r.attempts,
    }));
    writeFileSync(tmpPath, JSON.stringify(serializable), { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore on non-POSIX
    }
    renameSync(tmpPath, spoolPath);
  } catch (err) {
    console.warn(`[MQTT SPOOL] Could not persist spool file: ${err.message}`);
  }
}

export class ManagedMqttTransport {
  #config;
  #caPem;
  #spoolPath;
  #ackTimeoutMs;
  #client = null;
  #connected = false;
  #stopped = false;
  #connecting = false;
  #reconnectDelayMs = 2000;
  #reconnectTimer = null;
  #retryTimer = null;
  #spool = new Map();
  #maxQueue = 1000;

  constructor(
    config,
    {
      caPem = null,
      maxQueue = 1000,
      spoolPath = DEFAULT_SPOOL_PATH,
      ackTimeoutMs = 15_000,
    } = {},
  ) {
    this.#config = config;
    this.#caPem = caPem;
    this.#maxQueue = maxQueue;
    this.#spoolPath = spoolPath;
    this.#ackTimeoutMs = ackTimeoutMs;
    const baseTopic = `fleet/v1/${config.organization_id}/${config.device_id}`;
    this.upTopic = `${baseTopic}/up/telemetry`;
    this.ackTopic = `${baseTopic}/down/ingest_ack`;
    this.resTopic = `${baseTopic}/down/results`;

    for (const item of loadLocalSpool(this.#spoolPath)) {
      this.#spool.set(item.eventId, item);
    }
    if (this.#spool.size > 0) {
      console.log(
        `[MQTT SPOOL] Restored ${this.#spool.size} unacknowledged packet(s) from local storage for reposting.`,
      );
    }

    this.publishedCount = 0;
    this.ackCount = 0;
    this.lastSyncAt = null;
    this.lastError = null;
  }

  get connected() {
    return this.#connected;
  }

  get pendingRecords() {
    return this.#spool.size;
  }

  #persistSpool() {
    if (!this.#spoolPath) return;
    saveLocalSpool([...this.#spool.values()], this.#spoolPath);
  }

  async start() {
    this.#stopped = false;
    this.#retryTimer = setInterval(() => {
      this.#repostUnacknowledged();
    }, 3000);
    this.#retryTimer.unref?.();

    await this.#connectOnce().catch((error) => {
      this.lastError = error.message;
      console.error(`[MQTT] Initial connect failed (${error.message}); spooling locally and retrying...`);
      this.#scheduleReconnect();
    });
  }

  #handleIngestAck(payload) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    let changed = false;
    let newestAckedCreatedAt = 0;
    for (const r of msg.results || []) {
      if ((r.status === 'accepted' || r.status === 'duplicate') && typeof r.event_id === 'string') {
        const record = this.#spool.get(r.event_id);
        if (record) {
          if (record.createdAt > newestAckedCreatedAt) {
            newestAckedCreatedAt = record.createdAt;
          }
          this.#spool.delete(r.event_id);
          changed = true;
        }
        this.ackCount++;
        this.lastSyncAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
    }

    // Prune any older packet that has already been retried >= 5 times while newer packets were accepted
    if (newestAckedCreatedAt > 0) {
      for (const [id, rec] of this.#spool.entries()) {
        if (rec.createdAt < newestAckedCreatedAt && rec.attempts >= 5) {
          this.#spool.delete(id);
          changed = true;
        }
      }
    }

    if (changed) {
      this.#persistSpool();
    }
  }

  async #connectOnce() {
    if (this.#stopped || this.#connecting || this.#connected) return;
    this.#connecting = true;
    try {
      const client = new MinimalMqttClient(this.#config.broker_url, {
        clientId: this.#config.device_id,
        username: this.#config.broker_username,
        password: this.#config.auth_token,
        caPem: this.#caPem,
      });

      client.on('error', (err) => {
        this.lastError = err.message;
        console.error(`[MQTT] Error: ${err.message}`);
      });

      client.on('message', (topic, payload) => {
        if (topic === this.ackTopic) {
          this.#handleIngestAck(payload);
        } else if (topic === this.resTopic) {
          console.log(`[MQTT DOWN results] ${payload}`);
        }
      });

      client.on('close', () => {
        if (this.#client === client) {
          this.#connected = false;
          this.#client = null;
          // Mark any in-flight unacknowledged packets ready for immediate repost on reconnect
          for (const rec of this.#spool.values()) {
            rec.lastSentAt = 0;
          }
          if (!this.#stopped) {
            console.warn(
              `[MQTT] Disconnected (${this.#spool.size} unacknowledged packet(s) saved locally); reconnecting...`,
            );
            this.#scheduleReconnect();
          }
        }
      });

      await client.connect();
      this.#client = client;
      this.#connected = true;
      this.#reconnectDelayMs = 2000;
      this.lastError = null;
      client.subscribe([this.ackTopic, this.resTopic]);
      console.log(
        `[MQTT] Connected and subscribed to ${this.ackTopic} (pending spool=${this.#spool.size})`,
      );
      this.#repostUnacknowledged();
    } finally {
      this.#connecting = false;
    }
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(5000, Math.floor(this.#reconnectDelayMs * 1.5));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connectOnce().catch((error) => {
        this.lastError = error.message;
        this.#scheduleReconnect();
      });
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #repostUnacknowledged() {
    if (!this.#connected || !this.#client || this.#spool.size === 0) return;
    const now = Date.now();
    let sentThisBatch = 0;
    let changed = false;

    for (const [id, rec] of this.#spool.entries()) {
      if (now - rec.createdAt > SEVEN_DAYS_MS) {
        this.#spool.delete(id);
        changed = true;
        continue;
      }
      const due = rec.lastSentAt === 0 || now - rec.lastSentAt >= this.#ackTimeoutMs;
      if (!due) continue;

      try {
        const packetId = this.#client.publish(this.upTopic, rec.wireJson);
        rec.lastSentAt = now;
        rec.attempts++;
        this.publishedCount++;
        sentThisBatch++;
        changed = true;
        if (rec.attempts > 1) {
          console.log(
            `[MQTT REPOST] pkt=${packetId} event=${rec.eventId} attempt=${rec.attempts} (pending=${this.#spool.size})`,
          );
        }
        if (sentThisBatch >= 10) break;
      } catch (error) {
        this.lastError = error.message;
        this.#client?.disconnect();
        break;
      }
    }

    if (changed) {
      this.#persistSpool();
    }
  }

  publishPacket(eventId, wireJson) {
    const now = Date.now();
    if (!this.#spool.has(eventId)) {
      if (this.#spool.size >= this.#maxQueue) {
        const oldestKey = this.#spool.keys().next().value;
        if (oldestKey) this.#spool.delete(oldestKey);
      }
      this.#spool.set(eventId, {
        eventId,
        wireJson,
        createdAt: now,
        lastSentAt: 0,
        attempts: 0,
      });
    }
    const record = this.#spool.get(eventId);

    if (this.#connected && this.#client) {
      try {
        const packetId = this.#client.publish(this.upTopic, record.wireJson);
        record.lastSentAt = now;
        record.attempts++;
        this.publishedCount++;
        this.#persistSpool();
        return { queued: false, packetId };
      } catch (error) {
        this.lastError = error.message;
        this.#client?.disconnect();
      }
    }

    this.#persistSpool();
    return { queued: true, packetId: null };
  }

  acknowledgeEvent(eventId) {
    if (this.#spool.delete(eventId)) {
      this.ackCount++;
      this.lastSyncAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      this.#persistSpool();
      return true;
    }
    return false;
  }

  stop() {
    this.#stopped = true;
    if (this.#retryTimer) {
      clearInterval(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#connected = false;
    this.#client?.disconnect();
    this.#client = null;
    this.#persistSpool();
  }
}
