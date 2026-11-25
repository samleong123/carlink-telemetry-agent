import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readlink, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const USB_SERIAL_RE = /^\/dev\/tty(?:USB|ACM)\d+$/;
const PROBE_TIMEOUT_MS = 1500;
const SIM7600_MODEL_RE = /^(?:SIMCOM[ _-]+)?SIM7600[\w.-]*$/i;
const ACCESS_TYPES = ['GSM', 'GSM', 'WCDMA', 'GSM', 'WCDMA', 'WCDMA', 'WCDMA', 'LTE'];
const NMEA_MAX_AGE_MS = 5000;
const CONSTELLATIONS = {
  GP: 'GPS',
  GL: 'GLONASS',
  GA: 'Galileo',
  GB: 'BeiDou',
  BD: 'BeiDou',
  GQ: 'QZSS',
  GI: 'NavIC',
  GN: 'Mixed',
};

export class ModemError extends Error {}

export class AtModem {
  #buffer = '';
  #pending;
  #fatalError = null;
  #onDataListener;
  #onErrorListener;
  #onCloseListener;

  constructor(port, timeoutMs = 5000) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.#onDataListener = (chunk) => this.#onData(chunk);
    this.#onErrorListener = (error) => this.#fatal(error);
    this.#onCloseListener = (error) => this.#fatal(error ?? new Error('Serial port closed'));
    port.on('data', this.#onDataListener);
    port.on('error', this.#onErrorListener);
    port.on('close', this.#onCloseListener);
  }

  get closed() {
    return this.#fatalError !== null || !this.port.isOpen;
  }

  dispose(reason = new Error('AT modem closed')) {
    this.#fatal(reason);
    this.#buffer = '';
    const detach = (event, listener) => {
      if (typeof this.port?.off === 'function') this.port.off(event, listener);
      else if (typeof this.port?.removeListener === 'function') this.port.removeListener(event, listener);
    };
    detach('data', this.#onDataListener);
    detach('error', this.#onErrorListener);
    detach('close', this.#onCloseListener);
  }

  command(command, timeoutMs = this.timeoutMs) {
    if (this.#fatalError) return Promise.reject(this.#fatalError);
    if (this.#pending) return Promise.reject(new Error('An AT command is already in progress'));

    return new Promise((resolve, reject) => {
      const lines = [];
      const finish = (error) => {
        clearTimeout(timer);
        if (this.#pending === current) this.#pending = undefined;
        if (error) reject(error);
        else resolve(lines);
      };
      const timer = setTimeout(() => {
        this.#buffer = '';
        finish(new Error(`${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();

      const current = { command, lines, finish };
      this.#pending = current;
      this.port.write(`${command}\r`, (error) => {
        if (error) this.#fatal(error);
      });
    });
  }

  #fatal(error) {
    this.#fatalError ??= error;
    this.#pending?.finish(this.#fatalError);
  }

  #onData(chunk) {
    const lines = (this.#buffer + chunk.toString('ascii')).split(/[\r\n]+/);
    this.#buffer = lines.pop();
    if (this.#buffer.length > 4096) {
      this.#buffer = '';
      this.#pending?.finish(new Error('Serial input exceeded the AT response line limit'));
      return;
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const pending = this.#pending;
      if (!pending || !line || line === pending.command) continue;
      if (line === 'OK') {
        pending.finish();
      } else if (/^(?:ERROR$|\+(?:CME|CMS) ERROR(?::|$))/.test(line)) {
        pending.finish(new ModemError(`${pending.command} returned ${line}`));
      } else {
        pending.lines.push(line);
      }
    }
  }
}

export function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedNumber(value, min, max) {
  const n = optionalNumber(value);
  if (n === null || n < min || n > max) return null;
  return n;
}

function responseValue(lines, ...prefixes) {
  for (const prefix of prefixes) {
    const line = lines.find((value) => value.startsWith(prefix));
    if (line) return line.slice(prefix.length).trim();
  }
  return null;
}

export async function identifySim7600(modem, timeoutMs = PROBE_TIMEOUT_MS) {
  const lines = await modem.command('AT+CGMM', timeoutMs);
  return lines.some((line) => {
    const value = line.startsWith('+CGMM:') ? line.slice('+CGMM:'.length).trim() : line;
    return SIM7600_MODEL_RE.test(value);
  });
}

async function optionalCommand(modem, command) {
  try {
    return await modem.command(command);
  } catch (error) {
    if (!(error instanceof ModemError)) throw error;
    return [];
  }
}

export async function queryRows(modem, command, prefix) {
  const lines = await optionalCommand(modem, command);
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

const detailQueries = [
  ['manufacturer', 'AT+CGMI', /^SIMCOM\b/i, '+CGMI:'],
  ['model', 'AT+CGMM', /^(?:SIMCOM[_ -])?SIM7\d/i, '+CGMM:'],
  ['firmware', 'AT+CGMR', '+CGMR:'],
  ['imei', 'AT+CGSN', /^\d{15}$/],
  ['simStatus', 'AT+CPIN?', '+CPIN:'],
  ['iccid', 'AT+CICCID', '+ICCID:', '+CICCID:'],
  ['imsi', 'AT+CIMI', /^\d{5,15}$/],
  ['operator', 'AT+COPS?', '+COPS:'],
  ['lteRegistration', 'AT+CEREG?', '+CEREG:'],
  ['signalQuality', 'AT+CSQ', '+CSQ:'],
  ['servingCell', 'AT+CPSI?', '+CPSI:'],
];

export async function readDetails(modem) {
  const details = {};
  const warnings = [];

  for (const [field, command, ...prefixes] of detailQueries) {
    try {
      const lines = await modem.command(command);
      const [format, ...fallback] = prefixes;
      details[field] =
        format instanceof RegExp
          ? lines.find((line) => format.test(line)) ?? responseValue(lines, ...fallback)
          : responseValue(lines, ...prefixes);
      if (details[field] === null) warnings.push(`${command} returned no ${field} value`);
    } catch (error) {
      if (!(error instanceof ModemError)) throw error;
      details[field] = null;
      warnings.push(error.message);
    }
  }

  return { ...details, warnings };
}

function csv(value) {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((field) => field.trim().replace(/^"(.*)"$/, '$1') || null);
}

function signalDb(value, wholeUnitMin) {
  const raw = optionalNumber(value);
  if (raw === null || raw >= 0 || raw < wholeUnitMin * 10) return null;
  return raw < wholeUnitMin ? raw / 10 : raw;
}

function servingCell(fields) {
  const [mode, , plmn, areaCode, cellId, ...radio] = fields;
  if (!plmn || !cellId) return null;
  const cell = { plmn: plmn.replace('-', ''), cellId };

  if (/^LTE\b/.test(mode)) {
    const [pci, band, earfcn, dlBandwidthCode, ulBandwidthCode, rsrq, rsrp, rssi, rssnr] = radio;
    return {
      ...cell,
      tac: areaCode,
      pci: optionalNumber(pci),
      band: band ?? null,
      earfcn: optionalNumber(earfcn),
      dlBandwidthCode: optionalNumber(dlBandwidthCode),
      ulBandwidthCode: optionalNumber(ulBandwidthCode),
      rsrqDb: signalDb(rsrq, -35),
      rsrpDbm: signalDb(rsrp, -160),
      rssiDbm: signalDb(rssi, -150),
      sinrRaw: optionalNumber(rssnr),
    };
  }
  if (/^WCDMA\b/.test(mode)) {
    const [band, psc, uarfcn, , ecIo, rscp, , rxLev] = radio;
    return {
      ...cell,
      lac: areaCode,
      band: band ?? null,
      psc: optionalNumber(psc),
      uarfcn: optionalNumber(uarfcn),
      ecIoRaw: optionalNumber(ecIo),
      rscpRaw: optionalNumber(rscp),
      rxLevRaw: optionalNumber(rxLev),
    };
  }
  if (/^GSM\b/.test(mode)) {
    const [channelAndBand, rxLev] = radio;
    const [arfcn, ...band] = (channelAndBand ?? '').split(/\s+/);
    return {
      ...cell,
      lac: areaCode,
      arfcn: optionalNumber(arfcn),
      band: band.join(' ') || null,
      rxLevRaw: optionalNumber(rxLev),
    };
  }
  return null;
}

function indexed(rows) {
  const fields = rows.map(csv).filter(([cid]) => /^\d+$/.test(cid ?? ''));
  return new Map(fields.map(([cid, ...values]) => [Number(cid), values]));
}

async function readContexts(query, lte) {
  const configured = indexed(await query('AT+CGDCONT?', '+CGDCONT:'));
  const activation = indexed(await query('AT+CGACT?', '+CGACT:'));
  const active = indexed(await query('AT+CGCONTRDP', '+CGCONTRDP:'));
  const qos = lte ? indexed(await query('AT+CGEQOSRDP', '+CGEQOSRDP:')) : new Map();
  const ids = new Set([...configured.keys(), ...activation.keys(), ...active.keys(), ...qos.keys()]);

  return [...ids]
    .sort((a, b) => a - b)
    .map((cid) => {
      const [pdpType, configuredApn] = configured.get(cid) ?? [];
      const [bearerId, activeApn] = active.get(cid) ?? [];
      const [qci, , , , , dlAmbr, ulAmbr] = qos.get(cid) ?? [];
      const isActive = active.has(cid) || qos.has(cid) || activation.get(cid)?.[0] === '1';
      return {
        cid,
        active: isActive ? true : activation.has(cid) ? false : null,
        pdpType: pdpType ?? null,
        apn: activeApn ?? configuredApn ?? null,
        apnSource: activeApn ? 'active' : configuredApn ? 'configured' : null,
        bearerId: optionalNumber(bearerId),
        qci: optionalNumber(qci),
        ambrDownlinkKbps: optionalNumber(dlAmbr),
        ambrUplinkKbps: optionalNumber(ulAmbr),
      };
    });
}

export async function readNetwork(modem, { includeContexts = false } = {}) {
  const query = (command, prefix) => queryRows(modem, command, prefix);
  const [rawCell] = await query('AT+CPSI?', '+CPSI:');
  const fields = csv(rawCell ?? '');
  const [systemMode, operationMode] = fields;
  const [rawOperator] = await query('AT+COPS?', '+COPS:');
  const [, , operator, access] = csv(rawOperator ?? '');
  const networkType = systemMode?.replace(/-LIMITED$/, '') || ACCESS_TYPES[optionalNumber(access)] || null;

  const [registrationCommand, prefix] =
    networkType === 'LTE' ? ['AT+CEREG?', '+CEREG:'] : ['AT+CGREG?', '+CGREG:'];
  const [registration] = await query(registrationCommand, prefix);
  const [, status] = csv(registration ?? '');
  const registrationCode = optionalNumber(status);
  const [signal] = await query('AT+CSQ', '+CSQ:');
  const [rssi, ber] = csv(signal ?? '');
  const rssiIndex = optionalNumber(rssi);
  const rssiDbm =
    Number.isInteger(rssiIndex) && rssiIndex >= 0 && rssiIndex <= 31 ? -113 + 2 * rssiIndex : null;
  const cell = servingCell(fields);
  const isRegistered = registrationCode !== null && [1, 5].includes(registrationCode);
  const dataContexts =
    includeContexts || !isRegistered ? await readContexts(query, networkType === 'LTE') : [];

  return {
    networkType,
    systemMode: systemMode ?? null,
    operationMode: operationMode ?? null,
    operator: operator ?? null,
    accessTechnologyCode: optionalNumber(access),
    registrationCode,
    registered: registrationCode === null ? null : isRegistered,
    roaming: registrationCode === null ? null : registrationCode === 5,
    rssiDbm: cell?.rssiDbm ?? rssiDbm,
    csqBerIndex: ber === '99' ? null : optionalNumber(ber),
    servingCell: cell,
    dataContexts,
  };
}

function decimalDegrees(value, hemisphere, axis) {
  const isLatitude = axis === 'latitude';
  const format = isLatitude ? /^\d{4}(?:\.\d+)?$/ : /^\d{5}(?:\.\d+)?$/;
  const directions = isLatitude ? /^[NS]$/ : /^[EW]$/;
  const raw = Number(value);
  const degrees = Math.floor(raw / 100);
  const minutes = raw % 100;
  const limit = isLatitude ? 90 : 180;
  if (
    !format.test(value) ||
    !directions.test(hemisphere) ||
    minutes >= 60 ||
    degrees + minutes / 60 > limit
  ) {
    throw new Error(`Invalid GPS ${axis} in AT+CGPSINFO response`);
  }
  const decimal = Number((degrees + minutes / 60).toFixed(9));
  return decimal && /^[SW]$/.test(hemisphere) ? -decimal : decimal;
}

function parseFix(fields) {
  if (fields.length !== 9) throw new Error('Unexpected AT+CGPSINFO response');
  const [lat, northSouth, lon, eastWest, date, time, altitude, speed, course] = fields;
  if (!lat && !northSouth && !lon && !eastWest) return { fix: false };

  return {
    fix: true,
    latitude: decimalDegrees(lat, northSouth, 'latitude'),
    longitude: decimalDegrees(lon, eastWest, 'longitude'),
    utcDate: date || null,
    utcTime: time || null,
    altitudeMeters: optionalNumber(altitude),
    speedKnots: optionalNumber(speed),
    courseDegrees: optionalNumber(course),
  };
}

export async function startGps(modem) {
  const state = responseValue(await modem.command('AT+CGPS?'), '+CGPS:');
  if (/^0(?:,|$)/.test(state ?? '')) {
    await modem.command('AT+CGPS=1,1', 15000);
  } else if (!/^1(?:,|$)/.test(state ?? '')) {
    throw new Error(`Unexpected AT+CGPS? response: ${state ?? '(empty)'}`);
  }
}

async function readGpsFix(modem) {
  const value = responseValue(await modem.command('AT+CGPSINFO'), '+CGPSINFO:');
  if (value === null) throw new Error('Missing AT+CGPSINFO response');
  return parseFix(value.split(',').map((field) => field.trim()));
}

export async function readGnss(modem) {
  const lines = await optionalCommand(modem, 'AT+CGNSSINFO');
  const prefix = '+CGNSSINFO:';
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const value = index < 0 ? '' : lines[index].slice(prefix.length).trim() || lines[index + 1];
  const fields = value?.split(',').map((field) => field.trim());
  const hasGnss = fields?.length === 16;
  const fix = hasGnss ? parseFix(fields.slice(4, 13)) : await readGpsFix(modem);
  return {
    latitude: null,
    longitude: null,
    utcDate: null,
    utcTime: null,
    altitudeMeters: null,
    speedKnots: null,
    courseDegrees: null,
    ...fix,
    speedKmh: fix.speedKnots == null ? null : Number((fix.speedKnots * 1.852).toFixed(3)),
    fixMode: hasGnss ? optionalNumber(fields[0]) : null,
    satelliteCounts: hasGnss
      ? {
          gps: optionalNumber(fields[1]),
          glonass: optionalNumber(fields[2]),
          beidou: optionalNumber(fields[3]),
        }
      : null,
    pdop: hasGnss ? optionalNumber(fields[13]) : null,
    hdop: hasGnss ? optionalNumber(fields[14]) : null,
    vdop: hasGnss ? optionalNumber(fields[15]) : null,
  };
}

function sentenceFields(line) {
  const match = /^\$([A-Z]{2}(?:GSV|GST|RMC|GGA),[^*]*)\*([\dA-F]{2})$/i.exec(line.trim());
  if (!match) return [];
  const [, payload, checksum] = match;
  const actual = [...payload].reduce((xor, char) => xor ^ char.charCodeAt(0), 0);
  return actual === parseInt(checksum, 16) ? payload.split(',') : [];
}

export class NmeaReports {
  #partial = new Map();
  #satellites = new Map();
  #accuracy;
  #nmeaFix = null;

  receive(line) {
    const [sentence, ...fields] = sentenceFields(line);
    if (!sentence) return;
    const upperSentence = sentence.toUpperCase();
    const now = performance.now();

    if (upperSentence.endsWith('RMC')) {
      const [utcTime, status, lat, ns, lon, ew, speedKnots, course, utcDate] = fields;
      if (status === 'A' && lat && ns && lon && ew) {
        try {
          const latitude = decimalDegrees(lat, ns, 'latitude');
          const longitude = decimalDegrees(lon, ew, 'longitude');
          const spdKnots = optionalNumber(speedKnots);
          this.#nmeaFix = {
            ...(this.#nmeaFix ?? {}),
            at: now,
            fix: true,
            latitude,
            longitude,
            utcTime: utcTime || null,
            utcDate: utcDate || null,
            speedKnots: spdKnots,
            speedKmh: spdKnots == null ? null : Number((spdKnots * 1.852).toFixed(3)),
            courseDegrees: optionalNumber(course),
          };
        } catch {
          // Ignore malformed RMC coordinates
        }
      }
      return;
    }

    if (upperSentence.endsWith('GGA')) {
      const [utcTime, lat, ns, lon, ew, quality, numSat, hdop, altitude] = fields;
      const q = optionalNumber(quality);
      if (q !== null && q > 0 && lat && ns && lon && ew) {
        try {
          const latitude = decimalDegrees(lat, ns, 'latitude');
          const longitude = decimalDegrees(lon, ew, 'longitude');
          const satCount = optionalNumber(numSat);
          this.#nmeaFix = {
            ...(this.#nmeaFix ?? {}),
            at: now,
            fix: true,
            latitude,
            longitude,
            utcTime: utcTime || this.#nmeaFix?.utcTime || null,
            altitudeMeters: optionalNumber(altitude),
            hdop: optionalNumber(hdop),
            satelliteCounts:
              satCount !== null ? { gps: satCount, glonass: 0, beidou: 0 } : this.#nmeaFix?.satelliteCounts ?? null,
          };
        } catch {
          // Ignore malformed GGA coordinates
        }
      }
      return;
    }

    if (upperSentence.endsWith('GST')) {
      const [utcTime, , , , , latitudeError, longitudeError, altitudeError] = fields;
      const lat = optionalNumber(latitudeError);
      const lon = optionalNumber(longitudeError);
      if (lat !== null && lon !== null && lat >= 0 && lon >= 0) {
        this.#accuracy = {
          utcTime,
          at: now,
          horizontal: Number(Math.hypot(lat, lon).toFixed(3)),
          vertical: optionalNumber(altitudeError),
        };
      }
      return;
    }

    const [total, part, view, ...details] = fields;
    const parts = optionalNumber(total);
    const sequence = optionalNumber(part);
    const inView = optionalNumber(view);
    const signalId = details.length % 4 === 1 ? details.pop() || null : null;
    if (
      !Number.isInteger(parts) ||
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      sequence > parts ||
      details.length % 4 !== 0
    ) {
      return;
    }

    const talker = upperSentence.slice(0, 2);
    const key = `${talker}/${signalId ?? ''}`;
    const group =
      sequence === 1 ? { parts, sequence: 0, at: now, satellites: [] } : this.#partial.get(key);
    if (!group || group.parts !== parts || group.sequence + 1 !== sequence || now - group.at > NMEA_MAX_AGE_MS) {
      return;
    }

    for (let index = 0; index < details.length; index += 4) {
      const [id, elevation, azimuth, snr] = details.slice(index, index + 4);
      if (id) {
        group.satellites.push({
          id,
          elevationDegrees: optionalNumber(elevation),
          azimuthDegrees: optionalNumber(azimuth),
          snrDbHz: optionalNumber(snr),
        });
      }
    }
    group.sequence = sequence;
    if (sequence < parts) {
      this.#partial.set(key, group);
      return;
    }
    this.#partial.delete(key);
    this.#satellites.set(key, {
      at: now,
      report: {
        constellation: CONSTELLATIONS[talker] ?? talker,
        signalId,
        inView,
        satellites: group.satellites,
      },
    });
  }

  latestGpsFix(maxAgeMs = 10_000) {
    if (!this.#nmeaFix || performance.now() - this.#nmeaFix.at > maxAgeMs) {
      return null;
    }
    const base = {
      fix: true,
      latitude: this.#nmeaFix.latitude ?? null,
      longitude: this.#nmeaFix.longitude ?? null,
      utcDate: this.#nmeaFix.utcDate ?? null,
      utcTime: this.#nmeaFix.utcTime ?? null,
      altitudeMeters: this.#nmeaFix.altitudeMeters ?? null,
      speedKnots: this.#nmeaFix.speedKnots ?? null,
      speedKmh: this.#nmeaFix.speedKmh ?? null,
      courseDegrees: this.#nmeaFix.courseDegrees ?? null,
      fixMode: null,
      satelliteCounts: this.#nmeaFix.satelliteCounts ?? null,
      pdop: null,
      hdop: this.#nmeaFix.hdop ?? null,
      vdop: null,
    };
    return {
      ...base,
      ...this.snapshot(base),
    };
  }

  snapshot(gps) {
    const now = performance.now();
    const accuracy = this.#accuracy;
    const matchingFix =
      gps?.fix &&
      gps.utcTime &&
      accuracy &&
      now - accuracy.at <= NMEA_MAX_AGE_MS &&
      gps.utcTime.slice(0, 6) === accuracy.utcTime?.slice(0, 6);
    const satelliteDetails = [];
    for (const [key, value] of this.#satellites) {
      if (now - value.at > NMEA_MAX_AGE_MS) this.#satellites.delete(key);
      else satelliteDetails.push(value.report);
    }
    return {
      horizontalAccuracyMeters: matchingFix ? accuracy.horizontal : null,
      verticalAccuracyMeters: matchingFix ? accuracy.vertical : null,
      satelliteDetails: satelliteDetails.length ? satelliteDetails : null,
    };
  }
}

export async function openNmea(SerialPort, ReadlineParser, path, baudRate) {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  const reports = new NmeaReports();
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n', maxBufferSize: 16384 }));
  port.on('error', (error) => console.error(`[SIM7600G NMEA] ${path}: ${error.message}`));
  parser.on('data', (line) => reports.receive(line));
  try {
    await promisify(port.open).call(port);
    return { port, parser, reports };
  } catch (error) {
    await closeNmea({ port, parser, reports });
    throw error;
  }
}

export async function closeNmea(nmea) {
  if (!nmea) return;
  const { port, parser } = nmea;
  if (parser) {
    try {
      port?.unpipe?.(parser);
      parser.removeAllListeners?.();
      parser.destroy?.();
    } catch {
      // Ignore parser cleanup errors
    }
  }
  await closePort(port);
}

export async function closePort(port) {
  if (!port) return;
  let timer = null;
  try {
    if (port.isOpen) {
      await Promise.race([
        promisify(port.close).call(port).catch((error) => {
          console.error(`[SIM7600G] Could not close ${port.path}: ${error.message}`);
        }),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1000);
          timer.unref?.();
        }),
      ]);
    }
  } catch (error) {
    console.error(`[SIM7600G] Could not close ${port.path}: ${error.message}`);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      port.removeAllListeners?.();
      port.destroy?.();
    } catch {
      // Ignore destroy/cleanup errors
    }
  }
}

async function existingPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function usbInterface(path) {
  const devicePath = await existingPath(`/sys/class/tty/${basename(path)}/device`);
  const parts = devicePath?.split('/') ?? [];
  const index = parts.findIndex((part) => /^\d+-\d+(?:\.\d+)*:\d+\.\d+$/.test(part));
  if (index < 0) return null;
  return {
    device: parts.slice(0, index).join('/'),
    number: Number(parts[index].split('.').at(-1)),
  };
}

function normalizeDevPath(portName) {
  const clean = String(portName || '').trim();
  if (!clean) return null;
  return clean.startsWith('/dev/') ? clean : `/dev/${clean}`;
}

/** Parse `mmcli -m <id> -J` JSON output to see which AT and GPS ports ModemManager owns. */
export function parseMmcliModemJson(jsonInput) {
  const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
  const generic = parsed?.modem?.generic ?? parsed?.generic ?? {};
  const primaryPort = normalizeDevPath(generic['primary-port']);
  const atPorts = [];
  const gpsPorts = [];
  const otherPorts = [];

  for (const entry of generic.ports || []) {
    const match = /^\s*([^\s(]+)\s*\(([^)]+)\)\s*$/.exec(String(entry));
    if (!match) continue;
    const devPath = normalizeDevPath(match[1]);
    const kind = match[2].toLowerCase();
    if (kind === 'at') atPorts.push(devPath);
    else if (kind === 'gps') gpsPorts.push(devPath);
    else otherPorts.push({ path: devPath, kind });
  }

  return { primaryPort, atPorts, gpsPorts, otherPorts };
}

async function queryModemManagerPorts() {
  const info = {
    primaryPorts: new Set(),
    mmAtPorts: new Set(),
    mmGpsPorts: new Set(),
    mmManagedNames: [],
  };
  if (process.platform !== 'linux') return info;

  try {
    const { stdout: listJson } = await execFileAsync('mmcli', ['-L', '-J'], { timeout: 2500 });
    const list = JSON.parse(listJson);
    const modems = Array.isArray(list?.['modem-list']) ? list['modem-list'] : [];
    for (const modemRef of modems) {
      try {
        const { stdout: detailJson } = await execFileAsync('mmcli', ['-m', modemRef, '-J'], {
          timeout: 2500,
        });
        const parsed = parseMmcliModemJson(detailJson);
        if (parsed.primaryPort) info.primaryPorts.add(parsed.primaryPort);
        for (const p of parsed.atPorts) info.mmAtPorts.add(p);
        for (const p of parsed.gpsPorts) info.mmGpsPorts.add(p);
        info.mmManagedNames.push({
          modem: modemRef,
          primaryPort: parsed.primaryPort,
          atPorts: parsed.atPorts,
          gpsPorts: parsed.gpsPorts,
        });
      } catch {
        // Ignore single modem read error
      }
    }
  } catch {
    // mmcli unavailable or ModemManager not running
  }
  return info;
}

async function scanOpenSerialProcessFds() {
  const openByProcess = new Map(); // path -> Set<string> ("ModemManager(pid)")
  if (process.platform !== 'linux') return openByProcess;

  let pids = [];
  try {
    pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  } catch {
    return openByProcess;
  }

  await Promise.all(
    pids.map(async (pid) => {
      if (Number(pid) === process.pid) return;
      try {
        const fdEntries = await readdir(`/proc/${pid}/fd`);
        const ttyMatches = [];
        for (const fd of fdEntries) {
          try {
            const target = await readlink(`/proc/${pid}/fd/${fd}`);
            if (USB_SERIAL_RE.test(target)) ttyMatches.push(target);
          } catch {
            // FD disappeared or permission denied
          }
        }
        if (!ttyMatches.length) return;
        let comm = `pid:${pid}`;
        try {
          comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || comm;
        } catch {
          // Ignore
        }
        for (const tty of ttyMatches) {
          if (!openByProcess.has(tty)) openByProcess.set(tty, new Set());
          openByProcess.get(tty).add(`${comm}(${pid})`);
        }
      } catch {
        // Permission denied for other user process or exited
      }
    }),
  );

  return openByProcess;
}

export async function detectBusyModemPorts(candidatePaths = []) {
  const [mmInfo, openFds] = await Promise.all([
    queryModemManagerPorts(),
    scanOpenSerialProcessFds(),
  ]);

  const busyPorts = new Map(); // path -> reason string[]
  const addBusy = (path, reason) => {
    if (!path) return;
    if (!busyPorts.has(path)) busyPorts.set(path, []);
    const list = busyPorts.get(path);
    if (!list.includes(reason)) list.push(reason);
  };

  for (const primary of mmInfo.primaryPorts) {
    addBusy(primary, 'ModemManager primary-port');
  }
  for (const [path, procs] of openFds.entries()) {
    for (const proc of procs) {
      addBusy(path, `open by ${proc}`);
    }
  }

  // Optional fuser check when running non-root and /proc/<pid>/fd is unreadable
  if (process.platform === 'linux' && candidatePaths.length) {
    await Promise.all(
      candidatePaths.map(async (path) => {
        if (busyPorts.has(path)) return;
        try {
          const { stdout } = await execFileAsync('fuser', [path], { timeout: 1500 });
          const pids = stdout.trim();
          if (pids) addBusy(path, `in use by fuser pids: ${pids}`);
        } catch {
          // fuser exits 1 when not in use, or fuser binary not installed
        }
      }),
    );
  }

  return {
    busyPorts,
    mmInfo,
    openFds,
  };
}

/**
 * Pure candidate ranker for selecting the secondary AT port that ModemManager is NOT using.
 * Interface conventions on SIM7600 USB composition:
 *   if00 = Diag / QCDM (avoid)
 *   if01 = NMEA GPS stream (avoid for AT)
 *   if02 = Primary AT (typically held by ModemManager)
 *   if03 = Secondary AT (typically free for user telemetry)
 */
export function rankAtCandidates(ports, busyState) {
  const { busyPorts = new Map(), mmInfo = { primaryPorts: new Set(), mmAtPorts: new Set(), mmGpsPorts: new Set() } } =
    busyState || {};

  const scored = ports.map((entry) => {
    const path = entry.path;
    const ifNum = entry.usbInterfaceNumber ?? null;
    const busyReasons = busyPorts.get(path) || [];
    const isBusy = busyReasons.length > 0;
    const isMmPrimary = mmInfo.primaryPorts?.has(path);
    const isMmSecondaryAt = mmInfo.mmAtPorts?.has(path) && !isMmPrimary;
    const isKnownGpsOrDiag =
      mmInfo.mmGpsPorts?.has(path) || ifNum === 0 || ifNum === 1;

    // Lower score = preferred first
    let tier = 50;
    if (isBusy || isMmPrimary) {
      tier = 900; // Exclude busy / ModemManager-used port from primary selection
    } else if (isKnownGpsOrDiag) {
      tier = 800; // Do not probe Diag (if00) or NMEA (if01) unless explicitly forced
    } else if (isMmSecondaryAt) {
      tier = 0; // Explicitly reported by mmcli as an AT port that is NOT primary-port
    } else if (ifNum === 3 || /-if03(?:-port\d+)?$/i.test(entry.pnpId ?? '')) {
      tier = 10; // Secondary SIM7600 AT interface
    } else if (ifNum === 2 || /-if02(?:-port\d+)?$/i.test(entry.pnpId ?? '')) {
      tier = 20; // Primary SIM7600 AT interface (when ModemManager is not using it)
    } else if (ifNum !== null && ifNum >= 4) {
      tier = 30;
    } else if (path === '/dev/ttyUSB3') {
      tier = 40;
    } else if (path === '/dev/ttyUSB2') {
      tier = 45;
    }

    return {
      ...entry,
      isBusy,
      isMmPrimary,
      isMmSecondaryAt,
      isKnownGpsOrDiag,
      busyReasons,
      tier,
    };
  });

  return scored.sort((a, b) => a.tier - b.tier || a.path.localeCompare(b.path));
}

export async function inspectSerialTopology(SerialPort) {
  const rawList = await SerialPort.list();
  const usbEntries = await Promise.all(
    rawList
      .filter(({ path }) => USB_SERIAL_RE.test(path))
      .map(async (item) => {
        const real = (await existingPath(item.path)) ?? item.path;
        const iface = await usbInterface(real);
        return {
          ...item,
          realPath: real,
          usbDevice: iface?.device ?? null,
          usbInterfaceNumber: iface?.number ?? null,
        };
      }),
  );

  const busyState = await detectBusyModemPorts(usbEntries.map((e) => e.path));
  const ranked = rankAtCandidates(usbEntries, busyState);
  return { rawList, usbEntries, busyState, ranked };
}

async function connectAndIdentify(SerialPort, path, baudRate, detect) {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  const modem = new AtModem(port);
  try {
    await promisify(port.open).call(port);
    await modem.command('AT', detect ? PROBE_TIMEOUT_MS : undefined);
    if (detect && !(await identifySim7600(modem, PROBE_TIMEOUT_MS))) {
      throw new Error('AT+CGMM did not identify a SIM7600');
    }
    return modem;
  } catch (error) {
    modem.dispose(error);
    await closePort(port);
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

export function orderAtCandidates(ranked, deprioritizePath = null) {
  const deprioritizeSort = (a, b) =>
    (a.path === deprioritizePath ? 1 : 0) - (b.path === deprioritizePath ? 1 : 0);
  const freeCandidates = ranked
    .filter((c) => !c.isBusy && !c.isMmPrimary && !c.isKnownGpsOrDiag)
    .sort(deprioritizeSort);
  const nonPrimaryFallbacks = ranked
    .filter((c) => !c.isKnownGpsOrDiag && !c.isMmPrimary && !freeCandidates.includes(c))
    .sort(deprioritizeSort);
  const primaryFallbacks = ranked
    .filter((c) => !c.isKnownGpsOrDiag && c.isMmPrimary && !freeCandidates.includes(c))
    .sort(deprioritizeSort);

  return freeCandidates.length > 0
    ? freeCandidates
    : nonPrimaryFallbacks.length > 0
      ? nonPrimaryFallbacks
      : primaryFallbacks;
}

export async function selectSim7600AtPort(
  SerialPort,
  explicitPath,
  baudRate = 115200,
  { deprioritizePath = null } = {},
) {
  if (explicitPath !== undefined && explicitPath !== deprioritizePath) {
    try {
      const modem = await connectAndIdentify(SerialPort, explicitPath, baudRate, false);
      return { modem, topology: null, busySkipped: [] };
    } catch (err) {
      console.warn(
        `[SIM7600G] Explicit port ${explicitPath} unavailable (${err.message}); falling back to auto-detection...`,
      );
    }
  }

  const topology = await inspectSerialTopology(SerialPort);
  const { ranked } = topology;
  const ordered = orderAtCandidates(ranked, deprioritizePath);

  const busySkipped = ranked
    .filter((c) => c.isBusy || c.isMmPrimary)
    .map((c) => `${c.path} (${c.busyReasons.join(', ') || 'ModemManager'})`);

  if (busySkipped.length > 0) {
    console.log(`[SIM7600G] Busy/ModemManager ports noted: ${busySkipped.join('; ')}`);
  }

  const failures = [];
  for (const candidate of ordered) {
    try {
      const modem = await connectAndIdentify(SerialPort, candidate.path, baudRate, true);
      console.log(
        `[SIM7600G] Selected AT port ${candidate.path} (if${candidate.usbInterfaceNumber ?? '?'}${candidate.isBusy ? ', shared fallback' : ', secondary'})`,
      );
      return { modem, topology, busySkipped };
    } catch (error) {
      failures.push(error.message);
    }
  }

  const reason = failures.length
    ? failures.join('; ')
    : ordered.length === 0
      ? 'No ttyUSB/ttyACM AT candidates found.'
      : 'No candidate answered AT+CGMM as SIM7600.';
  throw new Error(`Could not detect a responsive SIM7600 AT port: ${reason}`);
}

export async function findFreeNmeaPort(SerialPort, atPath, busyPorts = new Map()) {
  const atTty = atPath ? await existingPath(atPath) : null;
  const atInterface = atTty && USB_SERIAL_RE.test(atTty) ? await usbInterface(atTty) : null;

  const candidates = (await SerialPort.list())
    .map(({ path }) => path)
    .filter((path) => USB_SERIAL_RE.test(path) && path !== atTty);

  const matches = await Promise.all(
    candidates.map(async (path) => {
      if (busyPorts.has(path)) return undefined;
      const candidate = await usbInterface(path);
      if (candidate?.number !== 1) return undefined;
      if (atInterface && candidate.device !== atInterface.device) return undefined;
      return path;
    }),
  );
  const siblings = matches.filter(Boolean);
  return siblings.length >= 1 ? siblings[0] : undefined;
}

const REG_STATUS_MAP = {
  0: 'not_registered',
  1: 'registered',
  2: 'searching',
  3: 'denied',
  4: 'unknown',
  5: 'roaming',
};

export function parseLteBandNumber(bandStr) {
  if (typeof bandStr === 'number' && Number.isFinite(bandStr)) {
    return boundedNumber(bandStr, 0, 1000);
  }
  if (typeof bandStr !== 'string') return null;
  const match = /(\d+)/.exec(bandStr);
  return match ? boundedNumber(Number(match[1]), 0, 1000) : null;
}

export function normalizeSinrDb(sinrRaw) {
  const n = optionalNumber(sinrRaw);
  if (n === null || n === 255 || n === 32767) return null;
  if (n >= -30 && n <= 50) return Number(n.toFixed(2));
  // Some SIM7600 firmwares report RSSNR in tenths of a dB (e.g. 125 => 12.5 dB)
  if (n > 50 && n <= 500) {
    const scaled = Number((n / 10).toFixed(2));
    return scaled >= -30 && scaled <= 50 ? scaled : null;
  }
  return null;
}

/** Map SIM7600G static details + 1Hz watch network snapshot into CarLink `pi_snapshot_v1.network`. */
export function formatNetworkForServer(staticDetails, net) {
  if (!net && !staticDetails) {
    return {
      modem_model: null,
      imei: null,
      imsi: null,
      registered_plmn: null,
      operator: null,
      network_type: null,
      registration_status: null,
      roaming: null,
      lte_band: null,
      earfcn: null,
      cell_id: null,
      pci: null,
      tac: null,
      rssi_dbm: null,
      rsrp_dbm: null,
      rsrq_db: null,
      sinr_db: null,
      connected: false,
    };
  }

  const cell = net?.servingCell ?? null;
  const regCode = net?.registrationCode ?? null;
  const hasActiveContext =
    Array.isArray(net?.dataContexts) && net.dataContexts.some((ctx) => ctx.active === true);
  const connected = net?.registered === true || hasActiveContext;

  const cleanStr = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 160) : null);

  return {
    modem_model: cleanStr(staticDetails?.model) ?? 'SIM7600G',
    imei: cleanStr(staticDetails?.imei),
    imsi: cleanStr(staticDetails?.imsi),
    registered_plmn: cleanStr(cell?.plmn),
    operator: cleanStr(net?.operator),
    network_type: cleanStr(net?.networkType),
    registration_status: REG_STATUS_MAP[regCode] ?? null,
    roaming: typeof net?.roaming === 'boolean' ? net.roaming : null,
    lte_band: parseLteBandNumber(cell?.band),
    earfcn: boundedNumber(cell?.earfcn, 0, 4000000),
    cell_id: cell?.cellId != null ? cleanStr(String(cell.cellId)) : null,
    pci: boundedNumber(cell?.pci, 0, 1007),
    tac: cell?.tac != null ? cleanStr(String(cell.tac)) : null,
    rssi_dbm: boundedNumber(net?.rssiDbm, -150, 0),
    rsrp_dbm: boundedNumber(cell?.rsrpDbm, -160, -20),
    rsrq_db: boundedNumber(cell?.rsrqDb, -50, 10),
    sinr_db: normalizeSinrDb(cell?.sinrRaw),
    connected: Boolean(connected),
  };
}

/** Map SIM7600G GNSS + NMEA snapshot into CarLink `pi_snapshot_v1.gps`. */
export function formatGpsForServer(gps, packetTimestamp) {
  if (!gps || gps.fix !== true) {
    return {
      latitude: null,
      longitude: null,
      altitude_m: null,
      speed_kmh: null,
      heading_deg: null,
      satellites: null,
      hdop: null,
      fix_valid: false,
      timestamp: null,
    };
  }

  const latitude = boundedNumber(gps.latitude, -90, 90);
  const longitude = boundedNumber(gps.longitude, -180, 180);
  if (latitude === null || longitude === null || !packetTimestamp) {
    return {
      latitude: null,
      longitude: null,
      altitude_m: null,
      speed_kmh: null,
      heading_deg: null,
      satellites: null,
      hdop: null,
      fix_valid: false,
      timestamp: null,
    };
  }

  let satellites = null;
  if (gps.satelliteCounts) {
    const sum =
      (gps.satelliteCounts.gps ?? 0) +
      (gps.satelliteCounts.glonass ?? 0) +
      (gps.satelliteCounts.beidou ?? 0);
    satellites = boundedNumber(sum, 0, 100);
  } else if (Array.isArray(gps.satelliteDetails)) {
    const sum = gps.satelliteDetails.reduce((acc, g) => acc + (g.inView ?? 0), 0);
    satellites = boundedNumber(sum, 0, 100);
  }

  return {
    latitude,
    longitude,
    altitude_m: boundedNumber(gps.altitudeMeters, -1000, 20000),
    speed_kmh: boundedNumber(gps.speedKmh, 0, 250),
    heading_deg: boundedNumber(gps.courseDegrees, 0, 360),
    satellites,
    hdop: boundedNumber(gps.hdop, 0, 100),
    fix_valid: true,
    // ProjectPiTelemetry requires gps.timestamp <= packet timestamp within 0..5s.
    timestamp: packetTimestamp,
  };
}

export class Sim7600Watcher {
  #serialPortPkg = null;
  #modem = null;
  #nmea = null;
  #timer = null;
  #stopped = false;
  #polling = false;
  #consecutiveErrors = 0;
  #lastFailedAtPort = null;
  #lastBusyPorts = new Map();
  #lastNmeaAttemptAt = 0;
  #lastConnectAttemptAt = 0;

  constructor({ portPath, baudRate = 115200, pollIntervalMs = 1000 } = {}) {
    this.explicitPort = portPath;
    this.baudRate = baudRate;
    this.pollIntervalMs = pollIntervalMs;
    this.atPortPath = null;
    this.nmeaPortPath = null;
    this.staticDetails = null;
    this.latestSample = null;
    this.lastError = null;
    this.busySkipped = [];
  }

  async start() {
    this.#serialPortPkg = await import('serialport').catch((error) => {
      throw new Error(`serialport dependency missing (${error.message})`);
    });
    try {
      await this.#connectAndInit();
      await this.#pollOnce();
    } catch (error) {
      this.lastError = error.message;
      console.warn(
        `[SIM7600G] Initial modem setup incomplete (${error.message}); background watcher will keep retrying all ports.`,
      );
    }
    this.#timer = setInterval(() => {
      void this.#pollOnce();
    }, this.pollIntervalMs);
    this.#timer.unref?.();
  }

  async #ensureNmeaOpen(busyPorts = null, { force = false } = {}) {
    if (this.#nmea && !this.#nmea.port?.isOpen) {
      await this.#closeNmeaHandle();
    }
    if (this.#nmea && this.#nmea.port?.isOpen) return;
    if (!this.#serialPortPkg) return;
    const now = Date.now();
    if (!force && now - this.#lastNmeaAttemptAt < 15_000) return;
    this.#lastNmeaAttemptAt = now;

    const { SerialPort, ReadlineParser } = this.#serialPortPkg;
    const effectiveBusyPorts = busyPorts ?? this.#lastBusyPorts;
    try {
      const nmeaPath = await findFreeNmeaPort(SerialPort, this.atPortPath, effectiveBusyPorts);
      if (nmeaPath) {
        this.#nmea = await openNmea(SerialPort, ReadlineParser, nmeaPath, this.baudRate);
        this.nmeaPortPath = nmeaPath;
        console.log(`[SIM7600G] Opened NMEA port ${nmeaPath}`);
      }
    } catch (error) {
      console.warn(`[SIM7600G] NMEA stream unavailable (${error.message}); continuing.`);
    }
  }

  async #connectAndInit() {
    this.#lastConnectAttemptAt = Date.now();
    const { SerialPort } = this.#serialPortPkg;
    // Always attempt to open the NMEA GPS stream even if all AT ports are busy
    await this.#ensureNmeaOpen(null, { force: true });

    const { modem, topology, busySkipped } = await selectSim7600AtPort(
      SerialPort,
      this.explicitPort,
      this.baudRate,
      { deprioritizePath: this.#lastFailedAtPort },
    );
    this.#modem = modem;
    this.atPortPath = modem.port.path;
    this.busySkipped = busySkipped;
    if (topology?.busyState?.busyPorts) {
      this.#lastBusyPorts = topology.busyState.busyPorts;
    }

    try {
      const details = await readDetails(modem);
      this.staticDetails = { ...(this.staticDetails ?? {}), ...details };
    } catch (error) {
      console.warn(`[SIM7600G] readDetails warning on ${this.atPortPath}: ${error.message}`);
    }

    try {
      await startGps(modem);
    } catch (error) {
      console.warn(`[SIM7600G] startGps warning on ${this.atPortPath}: ${error.message}`);
    }

    await this.#ensureNmeaOpen(this.#lastBusyPorts, { force: true });
  }

  async #pollOnce() {
    if (this.#stopped || this.#polling) return;
    this.#polling = true;
    try {
      await this.#ensureNmeaOpen();

      if (!this.#modem || this.#modem.closed) {
        await this.closeAtHandle();
        if (Date.now() - this.#lastConnectAttemptAt >= 5_000) {
          try {
            await this.#connectAndInit();
          } catch (connErr) {
            this.lastError = connErr.message;
          }
        }
      }

      let network = this.latestSample?.network ?? null;
      let gps = null;
      let atOk = false;

      if (this.#modem && !this.#modem.closed) {
        try {
          network = await readNetwork(this.#modem);
          atOk = true;
        } catch (netErr) {
          this.lastError = `readNetwork: ${netErr.message}`;
        }

        try {
          gps = await readGnss(this.#modem);
          atOk = true;
        } catch (gpsErr) {
          this.lastError = `readGnss: ${gpsErr.message}`;
        }
      }

      // If AT GNSS failed or did not have a fix, merge/fallback to live NMEA GPS sentences
      const nmeaDirectFix = this.#nmea?.reports.latestGpsFix();
      if ((!gps || !gps.fix) && nmeaDirectFix) {
        gps = nmeaDirectFix;
      } else if (gps) {
        const nmeaFields = this.#nmea?.reports.snapshot(gps) ?? {
          horizontalAccuracyMeters: null,
          verticalAccuracyMeters: null,
          satelliteDetails: null,
        };
        gps = { ...gps, ...nmeaFields };
      }

      if (atOk || gps) {
        this.latestSample = {
          observedAt: new Date().toISOString(),
          atPort: this.atPortPath,
          nmeaPort: this.nmeaPortPath,
          network,
          gps: gps ?? this.latestSample?.gps ?? { fix: false },
        };
      }

      if (atOk) {
        this.#consecutiveErrors = 0;
        this.#lastFailedAtPort = null;
        this.lastError = null;
      } else {
        this.#consecutiveErrors++;
        if (this.#consecutiveErrors >= 3 && this.#modem) {
          console.warn(
            `[SIM7600G] AT port ${this.atPortPath} unresponsive (${this.lastError}); rotating/reconnecting AT port...`,
          );
          this.#lastFailedAtPort = this.atPortPath;
          await this.closeAtHandle();
          this.#consecutiveErrors = 0;
        }
      }
    } catch (error) {
      this.#consecutiveErrors++;
      this.lastError = error.message;
      console.error(`[SIM7600G] Watch poll error (${this.#consecutiveErrors}): ${error.message}`);
      if (this.#consecutiveErrors >= 3) {
        this.#lastFailedAtPort = this.atPortPath;
        await this.closeAtHandle();
        this.#consecutiveErrors = 0;
      }
    } finally {
      this.#polling = false;
    }
  }

  getSnapshot(packetTimestamp) {
    const sample = this.latestSample;
    const nmeaFallback = this.#nmea?.reports.latestGpsFix();
    const stale =
      !sample || Date.now() - Date.parse(sample.observedAt) > Math.max(20_000, this.pollIntervalMs * 15);
    const activeGps = (!stale && sample?.gps?.fix ? sample.gps : nmeaFallback) ?? (stale ? null : sample?.gps);
    return {
      atPort: this.atPortPath,
      nmeaPort: this.nmeaPortPath,
      modemModel: this.staticDetails?.model ?? 'SIM7600G',
      stale: stale && !nmeaFallback,
      lastError: this.lastError,
      network: formatNetworkForServer(this.staticDetails, stale ? null : sample?.network),
      gps: formatGpsForServer(activeGps, packetTimestamp),
      rawSample: sample,
    };
  }

  async #closeNmeaHandle() {
    if (this.#nmea) {
      await closeNmea(this.#nmea);
      this.#nmea = null;
      this.nmeaPortPath = null;
    }
  }

  async closeAtHandle() {
    if (this.#modem) {
      this.#modem.dispose();
      await closePort(this.#modem.port);
      this.#modem = null;
      this.atPortPath = null;
    }
  }

  async closeHandles() {
    await this.#closeNmeaHandle();
    await this.closeAtHandle();
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.closeHandles();
  }
}

export async function runModemCheck({ portPath, baudRate = 115200 } = {}) {
  const { SerialPort } = await import('serialport');
  const { modem, busySkipped } = await selectSim7600AtPort(SerialPort, portPath, baudRate);
  try {
    const details = await readDetails(modem);
    await startGps(modem);
    const network = await readNetwork(modem, { includeContexts: true });
    const gps = await readGnss(modem);
    return {
      atPort: modem.port.path,
      busySkipped,
      details,
      network,
      gps,
    };
  } finally {
    modem.dispose();
    await closePort(modem.port);
  }
}

export async function listPortsReport() {
  const { SerialPort } = await import('serialport');
  const topology = await inspectSerialTopology(SerialPort);
  return {
    serialPorts: topology.rawList,
    modemManager: topology.busyState.mmInfo.mmManagedNames,
    rankedCandidates: topology.ranked.map((c) => ({
      path: c.path,
      interface: c.usbInterfaceNumber,
      tier: c.tier,
      busy: c.isBusy,
      mmPrimary: c.isMmPrimary,
      mmSecondaryAt: c.isMmSecondaryAt,
      reasons: c.busyReasons,
    })),
  };
}
