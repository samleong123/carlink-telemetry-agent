import { execFile } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeDtc } from './dtc-scan.js';

const AGENT_DIR = process.pkg ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OBD_LOG_PATH = join(AGENT_DIR, 'OBD2.log');
export const DEFAULT_OBD_LOG_RETENTION_MS = 4 * 60 * 60 * 1000;
const OBD_LOG_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const OBD_LOG_MAX_BYTES = 16 * 1024 * 1024;
const lastObdPruneAt = new Map();

export function formatObdLogLine({
  timestamp = new Date().toISOString(),
  mac = null,
  identity = null,
  supportedMask = null,
  raw = {},
  vehicle = null,
  dtcCodes = [],
}) {
  const payload = {
    timestamp,
    mac: mac || null,
    identity: identity || null,
    supported_mask:
      typeof supportedMask === 'number' && supportedMask > 0
        ? `0x${supportedMask.toString(16).toUpperCase()}`
        : null,
    raw: raw && typeof raw === 'object' ? raw : {},
    vehicle: vehicle ?? null,
    dtc_codes: Array.isArray(dtcCodes) ? dtcCodes : [],
  };
  return `${timestamp} | mac=${mac || 'unknown'} | ${JSON.stringify(payload)}\n`;
}

export function pruneObdLog(
  logPath = DEFAULT_OBD_LOG_PATH,
  { retentionMs = DEFAULT_OBD_LOG_RETENTION_MS, nowMs = Date.now() } = {},
) {
  if (!logPath || !existsSync(logPath)) return 0;
  const rawText = readFileSync(logPath, 'utf8');
  if (!rawText) return 0;

  const cutoffMs = nowMs - retentionMs;
  const kept = [];
  for (const line of rawText.split(/\r?\n/)) {
    if (!line) continue;
    const sep = line.indexOf(' | ');
    const tsStr = sep === -1 ? line : line.slice(0, sep);
    const ts = Date.parse(tsStr);
    if (Number.isFinite(ts) && ts >= cutoffMs) {
      kept.push(line);
    }
  }

  const dir = dirname(resolve(logPath));
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${logPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore on non-POSIX
  }
  renameSync(tmpPath, logPath);
  return kept.length;
}

export function appendObdLogEntry(
  entry,
  {
    logPath = DEFAULT_OBD_LOG_PATH,
    retentionMs = DEFAULT_OBD_LOG_RETENTION_MS,
    nowMs = Date.now(),
    forcePrune = false,
  } = {},
) {
  if (!logPath) return;
  try {
    const dir = dirname(resolve(logPath));
    mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, formatObdLogLine(entry), { mode: 0o600 });

    const lastPrune = lastObdPruneAt.get(logPath) ?? 0;
    let oversize = false;
    try {
      oversize = statSync(logPath).size >= OBD_LOG_MAX_BYTES;
    } catch {
      // Ignore stat failures
    }
    if (forcePrune || oversize || nowMs - lastPrune >= OBD_LOG_PRUNE_INTERVAL_MS) {
      if (lastObdPruneAt.size >= 16) {
        lastObdPruneAt.delete(lastObdPruneAt.keys().next().value);
      }
      lastObdPruneAt.set(logPath, nowMs);
      pruneObdLog(logPath, { retentionMs, nowMs });
    }
  } catch (err) {
    console.warn(`[OBD LOG] Could not write ${logPath}: ${err.message}`);
  }
}

const execFileAsync = promisify(execFile);
export const DEFAULT_DUDU_MAC = null;
export const PETROL_AFR = 14.7;
export const PETROL_DENSITY_G_PER_LITRE = 745;

const shortUuid = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;
const clean = (text) => String(text ?? '').replace(/[\r\n>]+/g, ' ').replace(/\s+/g, ' ').trim();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const validReading = (value) => Number.isFinite(value) && value >= 0;

export function fuelLitresPerHour(mafGps) {
  if (!validReading(mafGps)) return null;
  return (mafGps * 3600) / (PETROL_AFR * PETROL_DENSITY_G_PER_LITRE);
}

export class FuelTracker {
  constructor({ maxGapSeconds = 15, minimumEconomySpeedKmh = 3 } = {}) {
    this.maxGapSeconds = maxGapSeconds;
    this.minimumEconomySpeedKmh = minimumEconomySpeedKmh;
    this.reset();
  }

  reset() {
    this.totalLitres = 0;
    this.distanceKm = 0;
    this.coveredSeconds = 0;
    this.unknownSeconds = 0;
    this.previous = null;
  }

  update({ mafGps, speedKmh, directFuelLph, timeMs }) {
    if (!Number.isFinite(timeMs)) throw new TypeError('A monotonic timeMs is required');
    const direct = validReading(directFuelLph);
    const rateLph = direct ? directFuelLph : fuelLitresPerHour(mafGps);
    const rateSource = direct ? 'direct' : rateLph === null ? 'unknown' : 'maf';
    const valid = rateLph !== null && validReading(speedKmh);

    if (this.previous) {
      const elapsed = Math.max(0, (timeMs - this.previous.timeMs) / 1000);
      if (valid && this.previous.valid && elapsed <= this.maxGapSeconds) {
        this.totalLitres += (rateLph * elapsed) / 3600;
        this.distanceKm += (speedKmh * elapsed) / 3600;
        this.coveredSeconds += elapsed;
      } else {
        this.unknownSeconds += elapsed;
      }
    }
    this.previous = { timeMs, valid };

    return {
      rateLph: rateLph === null ? null : clamp(Number(rateLph.toFixed(4)), 0, 1000),
      rateSource,
      instantL100km:
        valid && speedKmh > 0 && speedKmh >= this.minimumEconomySpeedKmh
          ? clamp(Number(((rateLph * 100) / speedKmh).toFixed(3)), 0, 1000000)
          : null,
      totalLitres: clamp(Number(this.totalLitres.toFixed(6)), 0, 100000000),
      distanceKm: clamp(Number(this.distanceKm.toFixed(6)), 0, 100000000),
      averageL100km:
        this.distanceKm > 0
          ? clamp(Number(((this.totalLitres * 100) / this.distanceKm).toFixed(3)), 0, 1000000)
          : null,
      averageKmPerL:
        this.totalLitres > 0
          ? clamp(Number((this.distanceKm / this.totalLitres).toFixed(3)), 0, 1000000)
          : null,
    };
  }
}

export function pidReplies(raw, pid, size) {
  const frame = new RegExp(`^(?:[0-9A-F]{5}|[0-9A-F]{6}|[0-9A-F]{8}|[0-9A-F]{10})?41${pid}((?:[0-9A-F]{2})+)$`);
  return String(raw)
    .toUpperCase()
    .split(/[\r\n>]/)
    .flatMap((line) => {
      const payload = frame.exec(line.replace(/\s+/g, ''))?.[1];
      if (!payload || payload.length < size * 2) return [];
      return [Buffer.from(payload.slice(0, size * 2), 'hex')];
    });
}

function parseMode03Dtcs(raw) {
  const codes = new Set();
  for (const line of String(raw).toUpperCase().split(/[\r\n>]+/)) {
    const cleanLine = line.replace(/[^0-9A-F]/g, '');
    const idx = cleanLine.indexOf('43');
    if (idx < 0) continue;
    const hex = cleanLine.slice(idx + 2);
    for (let i = 0; i + 3 < hex.length; i += 4) {
      const a = Number.parseInt(hex.slice(i, i + 2), 16);
      const b = Number.parseInt(hex.slice(i + 2, i + 4), 16);
      if (a === 0 && b === 0) continue;
      codes.add(decodeDtc(a, b));
    }
  }
  return [...codes];
}

function parseAtrvVoltage(raw) {
  const match = /(\d+(?:\.\d+)?)\s*V/i.exec(String(raw));
  if (!match) return null;
  const v = Number(match[1]);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? Number(v.toFixed(2)) : null;
}

async function queryElm(tx, rx, command, timeout = 6000, signal) {
  if (signal?.aborted) throw new Error('timed_out');
  let text = '';
  let timer;
  let onValue;
  let onAbort;

  const reply = new Promise((resolve, reject) => {
    onValue = (chunk) => {
      text += Buffer.from(chunk).toString('ascii');
      const prompt = text.indexOf('>');
      if (prompt !== -1) resolve(text.slice(0, prompt + 1));
    };
    rx.on('valuechanged', onValue);
    timer = setTimeout(() => {
      const partial = clean(text);
      reject(
        new Error(
          `${command} timed out waiting for the ELM prompt${partial ? ` (received ${partial})` : ''}.`,
        ),
      );
    }, timeout);
    if (signal) {
      onAbort = () => reject(new Error('timed_out'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    const [, raw] = await Promise.all([
      Promise.resolve().then(() => tx.writeValueWithResponse(Buffer.from(`${command}\r`, 'ascii'))),
      reply,
    ]);
    return raw;
  } finally {
    clearTimeout(timer);
    rx.off('valuechanged', onValue);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function withTimeout(operation, label, ms) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function emptyVehicleSnapshot() {
  return {
    obd_connected: false,
    engine_running: null,
    engine_rpm: null,
    speed_kmh: null,
    coolant_temp_c: null,
    engine_load_pct: null,
    throttle_pct: null,
    intake_temp_c: null,
    maf_gps: null,
    fuel_rate_lph: null,
    fuel_level_pct: null,
    odometer_km: null,
    engine_runtime_s: null,
    ecu_voltage_v: null,
    mil_on: null,
    has_dtc_fault: null,
    calculated_fuel_consumption: {
      rateLph: null,
      rateSource: null,
      instantL100km: null,
      totalLitres: null,
      distanceKm: null,
      averageL100km: null,
      averageKmPerL: null,
    },
  };
}

export class BleObdCollector {
  #mac;
  #enabled;
  #bluetooth = null;
  #destroy = null;
  #adapter = null;
  #device = null;
  #tx = null;
  #rx = null;
  #connected = false;
  #paused = false;
  #exclusiveLock = Promise.resolve();
  #supportedMask = 0;
  #fuelTracker = new FuelTracker();
  #latestVehicle = emptyVehicleSnapshot();
  #latestDtcCodes = [];
  #loopRunning = false;
  #stopped = false;
  #lastDtcCheckAt = 0;
  #diagnosticHeader = null;
  #diagnosticProtocol = null;
  #logPath;
  #logRetentionMs;

  constructor({
    mac,
    enabled = true,
    onConfigurationUpdate,
    logPath = process.env.CARLINK_OBD_LOG_PATH || DEFAULT_OBD_LOG_PATH,
    logRetentionMs = DEFAULT_OBD_LOG_RETENTION_MS,
  } = {}) {
    this.#mac = String(mac || DEFAULT_DUDU_MAC || '').toUpperCase();
    this.activeMac = this.#mac;
    this.identity = null;
    this.#enabled =
      enabled && process.platform === 'linux' && /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(this.#mac);
    this.onConfigurationUpdate = onConfigurationUpdate;
    this.#logPath = logPath;
    this.#logRetentionMs = logRetentionMs;
    this.lastError = null;
  }

  get connected() {
    return this.#connected;
  }

  async start() {
    if (!this.#enabled) {
      if (process.platform !== 'linux') {
        this.lastError = 'BLE OBD requires Linux BlueZ';
      }
      return;
    }
    console.log(`[OBD] Connecting and initializing BLE OBD-II adapter (target=${this.#mac})...`);
    try {
      await this.#connectOnce();
      await this.#pollTelemetryCycle();
    } catch (error) {
      this.lastError = error.message;
      console.warn(`[OBD] Startup connection failed (${error.message}) — will retry in background.`);
      await this.#disconnectBle();
    }
    this.#loopRunning = true;
    void this.#runLoop();
  }

  async #runLoop() {
    while (!this.#stopped && this.#loopRunning) {
      try {
        if (!this.#connected) {
          await this.#connectOnce();
        }
        if (this.#connected && !this.#paused) {
          await this.#pollTelemetryCycle();
        }
      } catch (error) {
        if (this.lastError !== error.message) {
          console.warn(`[OBD] BLE poll/reconnect warning: ${error.message}`);
        }
        this.lastError = error.message;
        await this.#disconnectBle();
        await sleep(10_000).catch(() => {});
        continue;
      }
      await sleep(1000).catch(() => {});
    }
  }

  async #resolveTargetDevice() {
    try {
      const dev = await this.#adapter.waitDevice(this.#mac, 10_000);
      this.activeMac = this.#mac;
      return dev;
    } catch (primaryErr) {
      const discovered = await this.#adapter.devices().catch(() => []);
      for (const mac of discovered) {
        const upper = String(mac).toUpperCase();
        try {
          const d = await this.#adapter.getDevice(upper);
          const name = (await d.getName().catch(() => '')) || (await d.getAlias().catch(() => ''));
          if (upper === DEFAULT_DUDU_MAC || /\b(?:DUDU|OBD|V-?LINK|IOS-VLINK|ELM)/i.test(name)) {
            console.log(
              `[OBD] Configured MAC ${this.#mac} not found; matched discovered OBD adapter ${upper}${name ? ` (${name})` : ''}`,
            );
            this.activeMac = upper;
            return d;
          }
        } catch {
          // Ignore unreadable BlueZ device entry
        }
      }
      const listStr = discovered.length ? ` (seen in BlueZ: ${discovered.slice(0, 8).join(', ')})` : '';
      throw new Error(`Could not find ${this.#mac} in BlueZ${listStr}: ${primaryErr.message}`);
    }
  }

  async #connectOnce() {
    const { default: { createBluetooth } } = await import('node-ble');
    if (!this.#bluetooth) {
      const ble = createBluetooth();
      this.#bluetooth = ble.bluetooth;
      this.#destroy = ble.destroy;
    }
    this.#adapter = await this.#bluetooth.defaultAdapter();
    if (!(await this.#adapter.isPowered())) {
      await execFileAsync('bluetoothctl', ['power', 'on'], { timeout: 4000 }).catch(() => {});
      if (!(await this.#adapter.isPowered())) {
        throw new Error('Bluetooth adapter is off (run: sudo bluetoothctl power on)');
      }
    }
    let ownsDiscovery = false;
    if (!(await this.#adapter.isDiscovering())) {
      await this.#adapter.startDiscovery();
      ownsDiscovery = true;
    }
    try {
      this.#device = await this.#resolveTargetDevice();
      if (await this.#device.isConnected()) {
        console.log(`[OBD] ${this.activeMac} already connected in BlueZ; resetting stale link...`);
        await this.#device.disconnect().catch(() => {});
        await sleep(600);
      }
      console.log(`[OBD] Connecting BLE to ${this.activeMac}...`);
      await withTimeout(this.#device.connect(), 'BLE connection', 20_000);
      const gatt = await withTimeout(this.#device.gatt(), 'GATT discovery', 15_000);

      let tx = null;
      let rx = null;
      let activeSvc = null;
      for (const [svcShort, txShort, rxShort] of [
        ['fff0', 'fff2', 'fff1'],
        ['ae00', 'ae01', 'ae02'],
      ]) {
        try {
          const service = await gatt.getPrimaryService(shortUuid(svcShort));
          tx = await service.getCharacteristic(shortUuid(txShort));
          rx = await service.getCharacteristic(shortUuid(rxShort));
          activeSvc = svcShort.toUpperCase();
          break;
        } catch {
          // Try next service layout
        }
      }
      if (!tx || !rx) throw new Error('No DUDU OBD GATT characteristics (FFF0 or AE00) found');

      await rx.startNotifications();
      this.#tx = tx;
      this.#rx = rx;

      const identity = clean(await this.#sendRaw('ATI'));
      if (!/\b(?:ELM|OBD|STN)/i.test(identity)) {
        throw new Error(`Unexpected adapter identity: ${identity || 'empty'}`);
      }
      this.identity = identity;
      for (const cmd of ['ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATSP0']) {
        const reply = await this.#sendRaw(cmd);
        if (!/\bOK\b/i.test(reply)) {
          throw new Error(`Adapter rejected ${cmd}: ${clean(reply)}`);
        }
      }

      // Mark adapter connected as soon as BLE + ELM327 setup completes.
      this.#connected = true;
      this.lastError = null;
      this.#supportedMask = 0;

      try {
        const raw0100 = await this.#sendRaw('0100', 12_000);
        const masks = pidReplies(raw0100, '00', 4);
        if (masks.length > 0) {
          this.#supportedMask = masks[0].readUInt32BE(0);
          console.log(
            `[OBD] Connected & initialized ${this.activeMac} on service ${activeSvc} (${identity}, ECU 0100=0x${this.#supportedMask.toString(16).toUpperCase()})`,
          );
        } else {
          console.log(
            `[OBD] Connected & initialized ${this.activeMac} on service ${activeSvc} (${identity}); ECU 0100 returned no data yet (ignition may be OFF) — keeping BLE connected.`,
          );
        }
      } catch (ecuErr) {
        console.log(
          `[OBD] Connected & initialized ${this.activeMac} on service ${activeSvc} (${identity}); ECU 0100 probe timed out (${ecuErr.message}) — keeping BLE connected.`,
        );
      }
    } finally {
      if (ownsDiscovery) await this.#adapter.stopDiscovery().catch(() => {});
    }
  }

  #supportsLowPid(pidHex) {
    const code = Number.parseInt(pidHex, 16);
    if (code > 32) return true;
    return Boolean(this.#supportedMask & (1 << (32 - code)));
  }

  async #sendRaw(command, timeoutMs = 6000, signal) {
    if (!this.#tx || !this.#rx) throw new Error('OBD GATT transport not connected');
    return queryElm(this.#tx, this.#rx, command, timeoutMs, signal);
  }

  async #pollTelemetryCycle() {
    let release;
    const prev = this.#exclusiveLock;
    this.#exclusiveLock = new Promise((res) => {
      release = res;
    });
    await prev;
    const rawReadings = {};
    let snap = null;
    try {
      if (this.#paused || !this.#connected) return;
      snap = emptyVehicleSnapshot();
      snap.obd_connected = true;

      if (this.#supportedMask === 0) {
        try {
          const raw0100 = await this.#sendRaw('0100', 5000);
          rawReadings['0100'] = raw0100;
          const masks = pidReplies(raw0100, '00', 4);
          if (masks.length > 0) {
            this.#supportedMask = masks[0].readUInt32BE(0);
            console.log(
              `[OBD] Vehicle ECU responded to 0100 (bitmask=0x${this.#supportedMask.toString(16).toUpperCase()})`,
            );
          }
        } catch (err) {
          rawReadings['0100'] = `ERROR: ${err.message}`;
        }
      }

      if (this.#supportedMask === 0) {
        snap.engine_running = false;
        try {
          const rawAtrv = await this.#sendRaw('ATRV', 3000);
          rawReadings.ATRV = rawAtrv;
          snap.ecu_voltage_v = parseAtrvVoltage(rawAtrv);
        } catch (err) {
          rawReadings.ATRV = `ERROR: ${err.message}`;
          throw err;
        }
        this.#latestVehicle = snap;
        return;
      }

      const readPid = async (pid, size) => {
        if (!this.#supportsLowPid(pid)) return null;
        try {
          const raw = await this.#sendRaw(`01${pid}`, 4000);
          rawReadings[`01${pid}`] = raw;
          return pidReplies(raw, pid, size)[0] ?? null;
        } catch (err) {
          rawReadings[`01${pid}`] = `ERROR: ${err.message}`;
          return null;
        }
      };

      const rpmBuf = await readPid('0C', 2);
      if (rpmBuf) {
        snap.engine_rpm = clamp(Math.round((256 * rpmBuf[0] + rpmBuf[1]) / 4), 0, 20000);
        snap.engine_running = snap.engine_rpm > 100;
      }

      const spdBuf = await readPid('0D', 1);
      if (spdBuf) {
        snap.speed_kmh = clamp(spdBuf[0], 0, 250);
      }

      const coolBuf = await readPid('05', 1);
      if (coolBuf) snap.coolant_temp_c = clamp(coolBuf[0] - 40, -40, 215);

      const loadBuf = await readPid('04', 1);
      if (loadBuf) snap.engine_load_pct = clamp(Number(((loadBuf[0] * 100) / 255).toFixed(1)), 0, 100);

      const thrBuf = await readPid('11', 1);
      if (thrBuf) snap.throttle_pct = clamp(Number(((thrBuf[0] * 100) / 255).toFixed(1)), 0, 100);

      const iatBuf = await readPid('0F', 1);
      if (iatBuf) snap.intake_temp_c = clamp(iatBuf[0] - 40, -40, 215);

      const mafBuf = await readPid('10', 2);
      if (mafBuf) snap.maf_gps = clamp(Number(((256 * mafBuf[0] + mafBuf[1]) / 100).toFixed(2)), 0, 1000);

      const fuelRateBuf = await readPid('5E', 2);
      if (fuelRateBuf) {
        snap.fuel_rate_lph = clamp(Number(((256 * fuelRateBuf[0] + fuelRateBuf[1]) * 0.05).toFixed(3)), 0, 1000);
      }

      const fuelLvlBuf = await readPid('2F', 1);
      if (fuelLvlBuf) snap.fuel_level_pct = clamp(Number(((fuelLvlBuf[0] * 100) / 255).toFixed(1)), 0, 100);

      const runBuf = await readPid('1F', 2);
      if (runBuf) snap.engine_runtime_s = clamp(256 * runBuf[0] + runBuf[1], 0, 4294967295);

      const voltBuf = await readPid('42', 2);
      if (voltBuf) {
        snap.ecu_voltage_v = clamp(Number(((256 * voltBuf[0] + voltBuf[1]) / 1000).toFixed(2)), 0, 100);
      } else {
        try {
          const rawAtrv = await this.#sendRaw('ATRV', 3000);
          rawReadings.ATRV = rawAtrv;
          snap.ecu_voltage_v = parseAtrvVoltage(rawAtrv);
        } catch (err) {
          rawReadings.ATRV = `ERROR: ${err.message}`;
          throw err;
        }
      }

      const milBuf = await readPid('01', 4);
      if (milBuf) {
        snap.mil_on = Boolean(milBuf[0] & 0x80);
        const dtcCount = milBuf[0] & 0x7f;
        snap.has_dtc_fault = dtcCount > 0 || snap.mil_on;
        if (dtcCount > 0 && (this.#latestDtcCodes.length === 0 || Date.now() - this.#lastDtcCheckAt > 60_000)) {
          this.#lastDtcCheckAt = Date.now();
          try {
            const dtcRaw = await this.#sendRaw('03', 6000);
            rawReadings['03'] = dtcRaw;
            const parsedDtcs = parseMode03Dtcs(dtcRaw);
            if (parsedDtcs.length > 0) {
              this.#latestDtcCodes = parsedDtcs;
            }
          } catch (err) {
            rawReadings['03'] = `ERROR: ${err.message}`;
          }
        } else if (dtcCount === 0 && !snap.mil_on) {
          this.#latestDtcCodes = [];
        }
      }

      snap.calculated_fuel_consumption = this.#fuelTracker.update({
        mafGps: snap.maf_gps,
        speedKmh: snap.speed_kmh,
        directFuelLph: snap.fuel_rate_lph,
        timeMs: performance.now(),
      });

      this.#latestVehicle = snap;
    } finally {
      if (this.#logPath && Object.keys(rawReadings).length > 0) {
        appendObdLogEntry(
          {
            timestamp: new Date().toISOString(),
            mac: this.activeMac || this.#mac,
            identity: this.identity,
            supportedMask: this.#supportedMask,
            raw: rawReadings,
            vehicle: snap,
            dtcCodes: this.#latestDtcCodes,
          },
          {
            logPath: this.#logPath,
            retentionMs: this.#logRetentionMs,
          },
        );
      }
      release();
    }
  }

  getSnapshot() {
    if (!this.#connected) {
      return { vehicle: emptyVehicleSnapshot(), dtcCodes: [] };
    }
    return {
      vehicle: {
        ...this.#latestVehicle,
        calculated_fuel_consumption: { ...this.#latestVehicle.calculated_fuel_consumption },
      },
      dtcCodes: [...this.#latestDtcCodes],
    };
  }

  // Exclusive adapter contract for signed edge commands (command-runner compatible)
  async withExclusiveObd(fn) {
    let release;
    const prev = this.#exclusiveLock;
    this.#exclusiveLock = new Promise((res) => {
      release = res;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async pauseTelemetry() {
    this.#paused = true;
  }

  async resumeTelemetry() {
    this.#paused = false;
  }

  #functionalHeaderForProtocol() {
    const p = Number(this.#diagnosticProtocol);
    if (p === 3) return '686AF1';
    if (p === 4 || p === 5) return 'C233F1';
    if (p === 7 || p === 9) return 'DB33F1';
    return '7DF';
  }

  async readObdSpeed({ signal, preserveDiagnosticState = false } = {}) {
    if (!this.#connected) throw new Error('transport_failed');
    const savedHeader = preserveDiagnosticState ? this.#diagnosticHeader : null;
    const functionalHeader = this.#functionalHeaderForProtocol();
    const switchedHeader = Boolean(savedHeader && savedHeader !== functionalHeader);
    try {
      if (switchedHeader) {
        await this.#sendRaw(`ATSH${functionalHeader}`, 4000, signal);
      }
      const raw = await this.#sendRaw('010D', 6000, signal);
      const buf = pidReplies(raw, '0D', 1)[0];
      if (!buf) throw new Error('transport_failed');
      return {
        source: 'obd_pid_010d',
        speed_kmh: buf[0],
        observed_at: new Date().toISOString(),
      };
    } finally {
      if (switchedHeader && this.#connected) {
        await this.#sendRaw(`ATSH${savedHeader}`, 4000, signal).catch(() => {});
      }
    }
  }

  async send(command, { timeoutMs = 8000, signal } = {}) {
    if (!this.#connected) throw new Error('transport_failed');
    const normalized = String(command || '').trim().toUpperCase();
    const raw = await this.#sendRaw(command, timeoutMs, signal);
    if (/^(?:ATD|ATSP0)$/.test(normalized)) {
      this.#diagnosticHeader = null;
      this.#diagnosticProtocol = null;
    } else if (normalized.startsWith('ATSH')) {
      this.#diagnosticHeader = normalized.slice(4).trim() || null;
    } else if (normalized === 'ATDPN') {
      const m = String(raw).toUpperCase().match(/\bA?([0-9])\b/);
      if (m) this.#diagnosticProtocol = m[1];
    }
    return raw;
  }

  async restoreBaseline({ signal } = {}) {
    this.#diagnosticHeader = null;
    this.#diagnosticProtocol = null;
    if (!this.#connected) return;
    for (const cmd of ['ATD', 'ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATSP0']) {
      await this.#sendRaw(cmd, 4000, signal).catch(() => {});
    }
  }

  async applyConfiguration(parameters) {
    await this.onConfigurationUpdate?.(parameters);
  }

  async #disconnectBle() {
    this.#connected = false;
    this.#diagnosticHeader = null;
    this.#diagnosticProtocol = null;
    this.#lastDtcCheckAt = 0;
    this.#latestVehicle = emptyVehicleSnapshot();
    this.#latestDtcCodes = [];
    let timer = null;
    try {
      await Promise.race([
        (async () => {
          try {
            await this.#rx?.stopNotifications().catch(() => {});
          } catch {
            // Ignore
          }
          try {
            this.#rx?.removeAllListeners?.();
          } catch {
            // Ignore
          }
          try {
            await this.#device?.disconnect().catch(() => {});
          } catch {
            // Ignore
          }
          try {
            this.#device?.removeAllListeners?.();
          } catch {
            // Ignore
          }
          try {
            await this.#adapter?.stopDiscovery().catch(() => {});
          } catch {
            // Ignore
          }
        })(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1200);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.#tx = null;
    this.#rx = null;
    this.#device = null;
    this.#adapter = null;
    if (this.#destroy) {
      try {
        this.#destroy();
      } catch {
        // Ignore
      }
      this.#destroy = null;
      this.#bluetooth = null;
    }
  }

  async stop() {
    this.#stopped = true;
    this.#loopRunning = false;
    await this.#disconnectBle();
    if (this.#destroy) {
      try {
        this.#destroy();
      } catch {
        // Ignore
      }
      this.#destroy = null;
      this.#bluetooth = null;
    }
  }
}

export async function runObdCheck({ mac } = {}) {
  const collector = new BleObdCollector({ mac, enabled: true });
  try {
    await collector.start();
    if (!collector.connected) {
      throw new Error(collector.lastError || 'Could not connect to BLE OBD adapter');
    }
    const snap = collector.getSnapshot();
    return {
      mac: collector.activeMac,
      identity: collector.identity,
      vehicle: snap.vehicle,
    };
  } finally {
    await collector.stop();
  }
}
