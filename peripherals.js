import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);

const MPU6050_ADDR = 0x68;
const OLED_ADDR = 0x3c;
const GRAVITY_MPS2 = 9.80665;
const ACCEL_SCALE_2G = 16384.0;
const GYRO_SCALE_250DPS = 131.0;

const hex = (byte) => '0x' + byte.toString(16).padStart(2, '0');
const round2 = (n) => Number(n.toFixed(2));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** Parse a 14-byte MPU6050 register block (0x3B..0x48) into SI physical units. */
export function convertMpu6050Raw(data) {
  if (!Buffer.isBuffer(data) || data.length < 14) {
    throw new Error('MPU6050 sample buffer must be 14 bytes.');
  }
  const axRaw = data.readInt16BE(0);
  const ayRaw = data.readInt16BE(2);
  const azRaw = data.readInt16BE(4);
  const tempRaw = data.readInt16BE(6);
  const gxRaw = data.readInt16BE(8);
  const gyRaw = data.readInt16BE(10);
  const gzRaw = data.readInt16BE(12);

  return {
    acceleration: {
      x_mps2: clamp(round2((axRaw / ACCEL_SCALE_2G) * GRAVITY_MPS2), -200, 200),
      y_mps2: clamp(round2((ayRaw / ACCEL_SCALE_2G) * GRAVITY_MPS2), -200, 200),
      z_mps2: clamp(round2((azRaw / ACCEL_SCALE_2G) * GRAVITY_MPS2), -200, 200),
    },
    gyroscope: {
      x_dps: clamp(round2(gxRaw / GYRO_SCALE_250DPS), -4000, 4000),
      y_dps: clamp(round2(gyRaw / GYRO_SCALE_250DPS), -4000, 4000),
      z_dps: clamp(round2(gzRaw / GYRO_SCALE_250DPS), -4000, 4000),
    },
    chip_temp_c: round2(tempRaw / 340 + 36.53),
  };
}

/**
 * Evaluate driving behaviour over the sampled IMU window using configured thresholds.
 * When safety detection is disabled by subscription/plan, threshold flags evaluate to false.
 */
export function evaluateDrivingBehaviour(samples, thresholds, safetyEnabled = true) {
  const th = {
    harsh_braking: Number.isFinite(thresholds?.harsh_braking) ? thresholds.harsh_braking : 3.0,
    rapid_acceleration: Number.isFinite(thresholds?.rapid_acceleration)
      ? thresholds.rapid_acceleration
      : 3.0,
    sharp_cornering: Number.isFinite(thresholds?.sharp_cornering) ? thresholds.sharp_cornering : 3.5,
  };

  if (!samples || samples.length === 0) {
    return {
      sensor: 'MPU6050',
      acceleration: { x_mps2: null, y_mps2: null, z_mps2: null },
      gyroscope: { x_dps: null, y_dps: null, z_dps: null },
      threshold: th,
      harsh_braking: null,
      rapid_acceleration: null,
      sharp_cornering: null,
    };
  }

  const latest = samples[samples.length - 1];
  let minY = latest.acceleration.y_mps2;
  let maxY = latest.acceleration.y_mps2;
  let maxAbsX = Math.abs(latest.acceleration.x_mps2);

  for (const s of samples) {
    if (s.acceleration.y_mps2 < minY) minY = s.acceleration.y_mps2;
    if (s.acceleration.y_mps2 > maxY) maxY = s.acceleration.y_mps2;
    const absX = Math.abs(s.acceleration.x_mps2);
    if (absX > maxAbsX) maxAbsX = absX;
  }

  return {
    sensor: 'MPU6050',
    acceleration: latest.acceleration,
    gyroscope: latest.gyroscope,
    threshold: th,
    harsh_braking: safetyEnabled ? minY <= -th.harsh_braking : false,
    rapid_acceleration: safetyEnabled ? maxY >= th.rapid_acceleration : false,
    sharp_cornering: safetyEnabled ? maxAbsX >= th.sharp_cornering : false,
  };
}

async function readIso14443Uid(reader) {
  const uid = [];
  for (const level of [0x93, 0x95, 0x97]) {
    const part = await reader.transceive(Buffer.from([level, 0x20]));
    const bytes = part.data;
    if (bytes.length !== 5 || part.rxLastBits !== 0) return null;
    if ((bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3]) !== bytes[4]) return null;

    const select = Buffer.from([level, 0x70, ...bytes]);
    const crc = await reader.calcCrc(select);
    const response = await reader.transceive(Buffer.concat([select, crc]));
    if (response.data.length !== 3 || response.rxLastBits !== 0) return null;
    const more = (response.data[0] & 0x04) !== 0;
    if (more && bytes[0] !== 0x88) return null;

    uid.push(...bytes.subarray(more ? 1 : 0, 4));
    if (!more) return Buffer.from(uid).toString('hex').toUpperCase();
  }
  return null;
}

/**
 * Hardware-only validation of RC522 over SPI1 CS1 (/dev/spidev1.1).
 * Does not enter continuous polling or emit driver_session (NDEF format pending).
 */
export async function validateRc522({
  bus = 1,
  device = 1,
  speedHz = 500_000,
  readTagUid = false,
  timeoutMs = 30_000,
} = {}) {
  const { MFRC522 } = require('node-red-contrib-raspi5-rc522/lib/mfrc522.js');
  const reader = new MFRC522({ bus, device, speedHz });
  reader.open();
  try {
    const version = await reader.readReg(0x37);
    if (version !== 0x91 && version !== 0x92) {
      throw new Error(`unexpected RC522 VersionReg ${hex(version)}`);
    }
    const result = {
      ok: true,
      version: hex(version),
      uid: null,
      note: 'Validated hardware only; NDEF polling disabled until card format is defined',
    };

    if (readTagUid) {
      await reader.init();
      console.log('[RC522] Hold one ISO 14443-A card or key fob flat against the antenna...');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await reader.requestA()) {
          const uid = await readIso14443Uid(reader);
          if (uid) {
            result.uid = uid;
            return result;
          }
        }
        await sleep(100);
      }
      throw new Error(`no card UID read within ${Math.round(timeoutMs / 1000)} seconds`);
    }

    return result;
  } finally {
    reader.close();
  }
}

/**
 * Normalize an ISO 14443-A UID string (4, 7, or 10 bytes) and compute the
 * SHA-256 hex digest of its raw UID bytes.
 */
export function hashNfcUid(uidHex) {
  if (typeof uidHex !== 'string') {
    throw new Error('NFC UID must be a string.');
  }
  const cleanHex = uidHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (cleanHex.length < 8 || cleanHex.length > 20 || cleanHex.length % 2 !== 0) {
    throw new Error('NFC UID must be 4 to 10 bytes (8 to 20 even hex characters).');
  }
  return createHash('sha256').update(Buffer.from(cleanHex, 'hex')).digest('hex');
}

/**
 * Non-blocking background watcher for RC522 ISO 14443-A card taps over SPI.
 * Immediately hashes card UIDs locally and never logs or emits raw UIDs.
 */
export class Rc522CardWatcher {
  #reader = null;
  #running = false;
  #stopped = false;
  #pollTimer = null;
  #inFlightPoll = null;
  #lastTapFingerprint = null;
  #lastTapAtMs = 0;
  #missCount = 0;
  #onTap;
  #onError;
  #createReader;
  #now;

  constructor({
    bus = 1,
    device = 1,
    speedHz = 500_000,
    pollIntervalMs = 350,
    debounceMs = 5000,
    onTap = null,
    onError = null,
    createReader = null,
    now = Date.now,
  } = {}) {
    this.bus = bus;
    this.device = device;
    this.speedHz = speedHz;
    this.pollIntervalMs = pollIntervalMs;
    this.debounceMs = debounceMs;
    this.version = null;
    this.#onTap = onTap;
    this.#onError = onError;
    this.#createReader = createReader;
    this.#now = now;
  }

  async start() {
    if (this.#running) return;
    this.#stopped = false;

    let reader;
    if (this.#createReader) {
      reader = this.#createReader({ bus: this.bus, device: this.device, speedHz: this.speedHz });
    } else {
      const { MFRC522 } = require('node-red-contrib-raspi5-rc522/lib/mfrc522.js');
      reader = new MFRC522({ bus: this.bus, device: this.device, speedHz: this.speedHz });
    }

    await reader.open();
    try {
      const version = await reader.readReg(0x37);
      if (version !== 0x91 && version !== 0x92) {
        throw new Error(`unexpected RC522 VersionReg ${hex(version)}`);
      }
      await reader.init();
      this.version = hex(version);
      this.#reader = reader;
      this.#running = true;
      this.#scheduleNext(0);
    } catch (error) {
      try {
        await reader.close();
      } catch {
        // Ignore close errors
      }
      throw error;
    }
  }

  #scheduleNext(delayMs = this.pollIntervalMs) {
    if (!this.#running || this.#stopped) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      if (!this.#running || this.#stopped) return;
      this.#inFlightPoll = this.#pollOnce()
        .catch((error) => {
          this.#onError?.(error);
        })
        .finally(() => {
          this.#inFlightPoll = null;
          this.#scheduleNext(this.pollIntervalMs);
        });
    }, delayMs);
    this.#pollTimer.unref?.();
  }

  async #pollOnce() {
    if (!this.#running || !this.#reader) return;
    const present = await this.#reader.requestA();
    if (!present || !this.#running) {
      if (!present) {
        this.#missCount++;
        if (this.#missCount >= 2) {
          this.#lastTapFingerprint = null;
          this.#lastTapAtMs = 0;
        }
      }
      return;
    }
    const uid = await readIso14443Uid(this.#reader);
    if (!uid || !this.#running) {
      if (!uid) {
        this.#missCount++;
        if (this.#missCount >= 2) {
          this.#lastTapFingerprint = null;
          this.#lastTapAtMs = 0;
        }
      }
      return;
    }

    this.#missCount = 0;
    const fingerprint = hashNfcUid(uid);
    const nowMs = this.#now();
    if (
      this.#lastTapFingerprint === fingerprint &&
      nowMs - this.#lastTapAtMs < this.debounceMs
    ) {
      return;
    }
    this.#lastTapFingerprint = fingerprint;
    this.#lastTapAtMs = nowMs;

    const occurredAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await this.#onTap?.({ fingerprint, occurredAt });
  }

  async stop() {
    this.#running = false;
    this.#stopped = true;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#inFlightPoll) {
      try {
        await this.#inFlightPoll;
      } catch {
        // Ignore in-flight poll errors during shutdown
      }
    }
    if (this.#reader) {
      try {
        await this.#reader.close();
      } catch {
        // Ignore close errors
      }
      this.#reader = null;
    }
  }
}

export class I2cPeripherals {
  #bus = null;
  #oled = null;
  #font = null;
  #mpuReady = false;
  #oledReady = false;
  #pollTimer = null;
  #windowSamples = [];
  #latestSample = null;
  #lastOledText = '';
  #closed = false;

  constructor({ busNumber = 3, sampleIntervalMs = 200 } = {}) {
    this.busNumber = busNumber;
    this.sampleIntervalMs = sampleIntervalMs;
    this.mpuError = null;
    this.oledError = null;
  }

  get mpuOk() {
    return this.#mpuReady;
  }

  get oledOk() {
    return this.#oledReady;
  }

  async start() {
    const i2c = require('i2c-bus');
    this.#bus = i2c.openSync(this.busNumber);

    // Initialize OLED (0x3C)
    try {
      const Oled = require('oled-i2c-bus');
      this.#font = require('oled-font-5x7');
      this.#oled = new Oled(this.#bus, { width: 128, height: 64, address: OLED_ADDR });
      this.#oled.turnOnDisplay();
      this.#oledReady = true;
      this.renderLines([
        'CARLINK TELEMETRY',
        'I2C3 OLED: OK (0x3C)',
        'Init MPU6050/RC522...',
        'Init SIM7600G 4G/GPS',
      ]);
    } catch (error) {
      this.oledError = error.message;
      this.#oledReady = false;
    }

    // Initialize MPU6050 (0x68)
    try {
      const id = this.#bus.readByteSync(MPU6050_ADDR, 0x75);
      if (id !== MPU6050_ADDR) {
        throw new Error(`unexpected WHO_AM_I ${hex(id)}`);
      }
      this.#bus.writeByteSync(MPU6050_ADDR, 0x6b, 0x00);
      await sleep(100);
      this.#mpuReady = true;
      this.#sampleMpu();
      this.#pollTimer = setInterval(() => this.#sampleMpu(), this.sampleIntervalMs);
      this.#pollTimer.unref?.();
    } catch (error) {
      this.mpuError = error.message;
      this.#mpuReady = false;
    }
  }

  #sampleMpu() {
    if (this.#closed || !this.#mpuReady || !this.#bus) return;
    try {
      const data = Buffer.allocUnsafe(14);
      const count = this.#bus.readI2cBlockSync(MPU6050_ADDR, 0x3b, data.length, data);
      if (count !== data.length) throw new Error('short I2C read');
      const sample = convertMpu6050Raw(data);
      this.#latestSample = sample;
      this.#windowSamples.push(sample);
      if (this.#windowSamples.length > 200) this.#windowSamples.shift();
      this.mpuError = null;
    } catch (error) {
      this.mpuError = error.message;
    }
  }

  consumeDrivingBehaviour(thresholds, safetyEnabled = true) {
    if (!this.#mpuReady && !this.#latestSample) {
      return evaluateDrivingBehaviour([], thresholds, safetyEnabled);
    }
    const samples = this.#windowSamples.length
      ? this.#windowSamples.splice(0, this.#windowSamples.length)
      : [this.#latestSample];
    return evaluateDrivingBehaviour(samples, thresholds, safetyEnabled);
  }

  peekLatestImu() {
    return this.#latestSample;
  }

  renderLines(lines) {
    if (!this.#oledReady || !this.#oled || !this.#font || this.#closed) return;
    const clipped = lines.slice(0, 6).map((line) => String(line ?? '').slice(0, 21));
    const joined = clipped.join('\n');
    if (joined === this.#lastOledText) return;
    this.#lastOledText = joined;

    try {
      this.#oled.clearDisplay(clipped.length === 0);
      for (let i = 0; i < clipped.length; i++) {
        this.#oled.setCursor(0, i * 11);
        const text = clipped[i] || ' ';
        const isLast = i === clipped.length - 1;
        this.#oled.writeString(this.#font, 1, text, 1, false, isLast);
      }
    } catch (error) {
      this.oledError = error.message;
    }
  }

  async stop() {
    this.#closed = true;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#oledReady && this.#oled) {
      try {
        this.renderLines(['CARLINK TELEMETRY', 'Agent stopped', '', '']);
      } catch {
        // Ignore shutdown display errors
      }
    }
    if (this.#bus) {
      try {
        this.#bus.closeSync();
      } catch {
        // Ignore close errors
      }
      this.#bus = null;
    }
  }
}
