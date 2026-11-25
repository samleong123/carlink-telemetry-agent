import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  loadAgentConfig,
  loadRuntimeState,
  normalizeCommissioningConfig,
  normalizePlate,
  sanitizeRuntimeSettings,
  saveRuntimeState,
} from '../config.js';
import { CommandPoller, createDeviceApi, explainNormalDtcs, verifyCommand } from '../commands.js';
import { syncBootSettings } from '../index.js';
import {
  AtModem,
  closeNmea,
  closePort,
  formatGpsForServer,
  formatNetworkForServer,
  NmeaReports,
  normalizeSinrDb,
  orderAtCandidates,
  parseLteBandNumber,
  parseMmcliModemJson,
  rankAtCandidates,
} from '../modem.js';
import {
  encodeConnect,
  encodePuback,
  encodePublish,
  loadLocalSpool,
  ManagedMqttTransport,
  tryDecodePacket,
} from '../mqtt.js';
import {
  appendObdLogEntry,
  DEFAULT_OBD_LOG_PATH,
  DEFAULT_OBD_LOG_RETENTION_MS,
  FuelTracker,
  pidReplies,
  pruneObdLog,
} from '../obd.js';
import {
  convertMpu6050Raw,
  evaluateDrivingBehaviour,
  hashNfcUid,
  Rc522CardWatcher,
} from '../peripherals.js';
import {
  buildTelemetryPacket,
  toWholeSecondUtc,
  validatePiTelemetryPacket,
} from '../telemetry.js';

const AGENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEVICE_JSON_PATH = existsSync(join(AGENT_DIR, 'carlink-device.json'))
  ? join(AGENT_DIR, 'carlink-device.json')
  : join(AGENT_DIR, 'carlink-device.example.json');

test('loads and validates Pi/TelemetryAgent/carlink-device.json credentials and persists plate state', async () => {
  const raw = readFileSync(DEVICE_JSON_PATH, 'utf8');
  const creds = normalizeCommissioningConfig(raw);
  assert.equal(creds.device_id, '00000000-0000-0000-0000-000000000001');
  assert.equal(creds.organization_id, '00000000-0000-0000-0000-000000000001');
  assert.equal(creds.broker_username, 'd-00000000000000000000000000000001');
  assert.equal(creds.api_url, 'https://api.carlink.example.com');
  assert.equal(creds.broker_url, 'wss://broker.carlink.example.com/ws');

  assert.equal(normalizePlate(' abc 1234 '), 'ABC1234');

  const tmp = mkdtempSync(join(tmpdir(), 'carlink-agent-'));
  try {
    const statePath = join(tmp, '.telemetry-state.json');
    const first = await loadAgentConfig({
      configPath: DEVICE_JSON_PATH,
      statePath,
      plate: 'abc 1234',
    });
    assert.equal(first.plate, 'ABC1234');
    assert.equal(first.serial, 'pi-00000000-0000-0000-0000-000000000001');

    // Second run without --plate loads persisted plate automatically
    const second = await loadAgentConfig({
      configPath: DEVICE_JSON_PATH,
      statePath,
    });
    assert.equal(second.plate, 'ABC1234');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('selects secondary SIM7600 AT port when ModemManager owns primary-port', () => {
  const mmJson = {
    modem: {
      generic: {
        'primary-port': 'ttyUSB2',
        ports: [
          'cdc-wdm0 (qmi)',
          'ttyUSB0 (qcdm)',
          'ttyUSB1 (gps)',
          'ttyUSB2 (at)',
          'ttyUSB3 (at)',
        ],
      },
    },
  };
  const parsed = parseMmcliModemJson(mmJson);
  assert.equal(parsed.primaryPort, '/dev/ttyUSB2');
  assert.deepEqual(parsed.atPorts, ['/dev/ttyUSB2', '/dev/ttyUSB3']);
  assert.deepEqual(parsed.gpsPorts, ['/dev/ttyUSB1']);

  const ports = [
    { path: '/dev/ttyUSB0', usbInterfaceNumber: 0 },
    { path: '/dev/ttyUSB1', usbInterfaceNumber: 1 },
    { path: '/dev/ttyUSB2', usbInterfaceNumber: 2 },
    { path: '/dev/ttyUSB3', usbInterfaceNumber: 3 },
  ];

  const busyPorts = new Map([['/dev/ttyUSB2', ['ModemManager primary-port', 'open by ModemManager(812)']]]);
  const ranked = rankAtCandidates(ports, {
    busyPorts,
    mmInfo: {
      primaryPorts: new Set([parsed.primaryPort]),
      mmAtPorts: new Set(parsed.atPorts),
      mmGpsPorts: new Set(parsed.gpsPorts),
    },
  });

  assert.equal(ranked[0].path, '/dev/ttyUSB3');
  assert.equal(ranked[0].isBusy, false);
  assert.equal(ranked[0].isMmSecondaryAt, true);
  assert.ok(ranked.find((p) => p.path === '/dev/ttyUSB2').isMmPrimary);
  assert.ok(ranked.find((p) => p.path === '/dev/ttyUSB2').tier >= 900);
  assert.ok(ranked.find((p) => p.path === '/dev/ttyUSB1').tier >= 800);
});

test('maps SIM7600G network and GPS samples into bounded CarLink schema objects', () => {
  assert.equal(parseLteBandNumber('EUTRAN-BAND3'), 3);
  assert.equal(normalizeSinrDb(14), 14);
  assert.equal(normalizeSinrDb(125), 12.5);
  assert.equal(normalizeSinrDb(255), null);

  const staticDetails = {
    model: 'SIMCOM_SIM7600G-H',
    imei: '860123456789012',
    imsi: '502123456789012',
  };
  const netSample = {
    networkType: 'LTE',
    operator: 'CelcomDigi',
    registrationCode: 1,
    registered: true,
    roaming: false,
    rssiDbm: -68,
    servingCell: {
      plmn: '50212',
      cellId: '12345678',
      tac: '3456',
      pci: 123,
      band: 'EUTRAN-BAND3',
      earfcn: 1650,
      rsrqDb: -11,
      rsrpDbm: -95,
      rssiDbm: -68,
      sinrRaw: 125,
    },
    dataContexts: [{ cid: 1, active: true }],
  };
  const mappedNet = formatNetworkForServer(staticDetails, netSample);
  assert.equal(mappedNet.lte_band, 3);
  assert.equal(mappedNet.sinr_db, 12.5);
  assert.equal(mappedNet.registration_status, 'registered');
  assert.equal(mappedNet.connected, true);

  const stamp = toWholeSecondUtc(new Date('2026-11-19T15:15:00.456Z'));
  const mappedGps = formatGpsForServer(
    {
      fix: true,
      latitude: 3.139,
      longitude: 101.6869,
      altitudeMeters: 45.2,
      speedKmh: 52.3,
      courseDegrees: 135.5,
      satelliteCounts: { gps: 7, glonass: 3, beidou: 2 },
      hdop: 0.9,
    },
    stamp,
  );
  assert.equal(mappedGps.fix_valid, true);
  assert.equal(mappedGps.satellites, 12);
  assert.equal(mappedGps.timestamp, '2026-11-19T15:15:00Z');

  const noFixGps = formatGpsForServer({ fix: false }, stamp);
  assert.equal(noFixGps.fix_valid, false);
  assert.equal(noFixGps.latitude, null);
  assert.equal(noFixGps.timestamp, null);
});

test('converts MPU6050 14-byte sample and evaluates harsh driving thresholds', () => {
  const buf = Buffer.alloc(14);
  // accelX = 0, accelY = -10000 (~ -5.98 m/s2), accelZ = 16384 (+9.81 m/s2)
  buf.writeInt16BE(0, 0);
  buf.writeInt16BE(-10000, 2);
  buf.writeInt16BE(16384, 4);
  buf.writeInt16BE(0, 6);
  buf.writeInt16BE(131, 8); // 1.0 dps
  buf.writeInt16BE(-262, 10); // -2.0 dps
  buf.writeInt16BE(0, 12);

  const parsed = convertMpu6050Raw(buf);
  assert.equal(parsed.acceleration.z_mps2, 9.81);
  assert.ok(parsed.acceleration.y_mps2 < -5.9);
  assert.equal(parsed.gyroscope.x_dps, 1);
  assert.equal(parsed.gyroscope.y_dps, -2);

  const beh = evaluateDrivingBehaviour([parsed], { harsh_braking: 3.0, rapid_acceleration: 3.0, sharp_cornering: 3.5 }, true);
  assert.equal(beh.sensor, 'MPU6050');
  assert.equal(beh.harsh_braking, true);
  assert.equal(beh.rapid_acceleration, false);
  assert.equal(beh.sharp_cornering, false);

  const disabled = evaluateDrivingBehaviour([parsed], { harsh_braking: 3.0 }, false);
  assert.equal(disabled.harsh_braking, false);
});

test('builds schema-valid pi_snapshot_v1 packet, omits driver_session, and preserves dtc_codes', async () => {
  const stamp = toWholeSecondUtc(new Date('2026-11-19T15:20:00.890Z'));
  const packet = buildTelemetryPacket({
    serial: 'pi-00000000-0000-0000-0000-000000000001',
    plate: 'ABC 1234',
    now: new Date('2026-11-19T15:20:00.890Z'),
    network: formatNetworkForServer(
      { model: 'SIM7600G-H', imei: '860123456789012', imsi: '502123456789012' },
      { networkType: 'LTE', operator: 'CelcomDigi', registrationCode: 1, registered: true, roaming: false, rssiDbm: -70 },
    ),
    gps: formatGpsForServer({ fix: false }, stamp),
    vehicle: {
      obd_connected: true,
      engine_running: true,
      engine_rpm: 1850,
      speed_kmh: 48,
      coolant_temp_c: 88,
      engine_load_pct: 32.1,
      throttle_pct: 15.0,
      intake_temp_c: 34,
      maf_gps: 10.5,
      fuel_rate_lph: null,
      fuel_level_pct: 70,
      odometer_km: null,
      engine_runtime_s: 1200,
      ecu_voltage_v: 13.8,
      mil_on: true,
      has_dtc_fault: false,
      dtc_codes: ['P0420'],
      calculated_fuel_consumption: new FuelTracker().update({ mafGps: 10.5, speedKmh: 48, timeMs: 1000 }),
    },
  });

  const explained = [];
  const { packet: sanitized, codes_discarded } = await explainNormalDtcs(
    packet,
    ['P0420'],
    { explain: async (code) => ({ code, component: 'OBD' }) },
    (exp) => explained.push(exp),
  );

  assert.equal(codes_discarded, 0);
  assert.equal(explained.length, 1);
  assert.deepEqual(sanitized.vehicle.dtc_codes, ['P0420']);
  assert.equal(sanitized.vehicle.has_dtc_fault, true);
  assert.equal('driver_session' in sanitized, false);
  assert.equal(validatePiTelemetryPacket(sanitized), null);
});

test('verifies HMAC signed commands and MQTT QoS 1 framing', () => {
  const config = normalizeCommissioningConfig(readFileSync(DEVICE_JSON_PATH, 'utf8'));
  const now = Date.now();
  const cmd = {
    id: randomUUID(),
    organization_id: config.organization_id,
    device_id: config.device_id,
    vehicle_id: randomUUID(),
    installation_id: randomUUID(),
    kind: 'configuration',
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    parameters: {
      telemetry_interval_seconds: 10,
      cellular_enabled: true,
      safety_enabled: true,
    },
  };
  const wire_payload = JSON.stringify(cmd);
  const signature = createHmac('sha256', config.auth_token).update(wire_payload, 'utf8').digest('hex');
  const verified = verifyCommand({ wire_payload, signature }, config, now);
  assert.equal(verified.parameters.telemetry_interval_seconds, 10);
  assert.throws(() => verifyCommand({ wire_payload, signature: '0'.repeat(64) }, config, now));

  const conn = encodeConnect({ clientId: config.device_id, username: config.broker_username, password: config.auth_token });
  assert.equal(conn[0], 0x10);
  const pub = encodePublish({ topic: `fleet/v1/${config.organization_id}/${config.device_id}/up/telemetry`, payload: '{"ok":true}', packetId: 9, qos: 1 });
  const stream = Buffer.concat([pub, encodePuback(9)]);
  const first = tryDecodePacket(stream);
  assert.equal(first.packet.type, 'PUBLISH');
  assert.equal(first.packet.packetId, 9);
  const second = tryDecodePacket(first.rest);
  assert.equal(second.packet.type, 'PUBACK');
  assert.equal(second.packet.packetId, 9);

  // OBD PID parsing smoke test
  const rpm = pidReplies('7E8 04 41 0C 1A F8', '0C', 2);
  assert.equal(rpm.length, 1);
  assert.equal((256 * rpm[0][0] + rpm[0][1]) / 4, 1726);
});

function withNmeaChecksum(payload) {
  const xor = [...payload].reduce((acc, ch) => acc ^ ch.charCodeAt(0), 0);
  return `$${payload}*${xor.toString(16).toUpperCase().padStart(2, '0')}`;
}

test('NmeaReports parses RMC and GGA sentences directly when AT ports are unavailable', () => {
  const reports = new NmeaReports();
  reports.receive(
    withNmeaChecksum('GPRMC,152000.00,A,0308.3400,N,10141.2140,E,28.24,135.5,191126,,,A'),
  );
  reports.receive(
    withNmeaChecksum('GPGGA,152000.00,0308.3400,N,10141.2140,E,1,11,0.9,45.2,M,-10.0,M,,'),
  );
  const fix = reports.latestGpsFix();
  assert.ok(fix);
  assert.equal(fix.fix, true);
  assert.equal(Number(fix.latitude.toFixed(4)), 3.139);
  assert.equal(Number(fix.longitude.toFixed(4)), 101.6869);
  assert.equal(fix.altitudeMeters, 45.2);
  assert.equal(fix.hdop, 0.9);
  assert.equal(fix.satelliteCounts.gps, 11);

  const serverGps = formatGpsForServer(fix, '2026-11-19T15:20:00Z');
  assert.equal(serverGps.fix_valid, true);
  assert.equal(serverGps.satellites, 11);
});

test('ManagedMqttTransport marks unacknowledged packets locally on disk and clears on server ack', () => {
  const config = normalizeCommissioningConfig(readFileSync(DEVICE_JSON_PATH, 'utf8'));
  const tmp = mkdtempSync(join(tmpdir(), 'carlink-spool-'));
  try {
    const spoolPath = join(tmp, '.telemetry-spool.json');
    const mqtt1 = new ManagedMqttTransport(config, { spoolPath });
    const id1 = randomUUID();
    const id2 = randomUUID();

    // Offline publish marks both packets locally on disk
    const res1 = mqtt1.publishPacket(id1, JSON.stringify({ event_id: id1 }));
    const res2 = mqtt1.publishPacket(id2, JSON.stringify({ event_id: id2 }));
    assert.equal(res1.queued, true);
    assert.equal(res2.queued, true);
    assert.equal(mqtt1.pendingRecords, 2);

    const diskRecords = loadLocalSpool(spoolPath);
    assert.equal(diskRecords.length, 2);

    // New transport instance restores unacknowledged packets from disk
    const mqtt2 = new ManagedMqttTransport(config, { spoolPath });
    assert.equal(mqtt2.pendingRecords, 2);

    // Server ingest_ack removes acknowledged packet from local spool
    assert.equal(mqtt2.acknowledgeEvent(id1), true);
    assert.equal(mqtt2.pendingRecords, 1);
    assert.equal(loadLocalSpool(spoolPath).length, 1);
    assert.equal(loadLocalSpool(spoolPath)[0].eventId, id2);

    mqtt1.stop();
    mqtt2.stop();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('hashNfcUid normalizes separators/casing, hashes raw UID bytes, and rejects invalid UIDs', () => {
  const colonUid = hashNfcUid('04:a3:22:1b:5c:80:01');
  const plainUid = hashNfcUid('04A3221B5C8001');
  const dashUid = hashNfcUid(' 04-A3-22-1B-5C-80-01 ');

  assert.equal(colonUid, plainUid);
  assert.equal(colonUid, dashUid);
  assert.match(colonUid, /^[0-9a-f]{64}$/);
  assert.equal(
    colonUid,
    createHash('sha256').update(Buffer.from('04a3221b5c8001', 'hex')).digest('hex'),
  );

  // 4-byte and 10-byte UIDs are valid
  assert.match(hashNfcUid('DE:AD:BE:EF'), /^[0-9a-f]{64}$/);
  assert.match(hashNfcUid('0102030405060708090A'), /^[0-9a-f]{64}$/);

  // Rejects non-string, too short, odd length, or >10 bytes
  assert.throws(() => hashNfcUid(null));
  assert.throws(() => hashNfcUid('04A322'));
  assert.throws(() => hashNfcUid('04A3221B5'));
  assert.throws(() => hashNfcUid('0102030405060708090A0B'));
});

test('buildTelemetryPacket attaches valid driver_session when active and omits when null', () => {
  const sessionId = randomUUID();
  const startedAt = '2026-11-20T09:01:37Z';
  const withDriver = buildTelemetryPacket({
    serial: 'pi-00000000-0000-0000-0000-000000000001',
    plate: 'ABC 1234',
    now: new Date('2026-11-20T09:02:00.500Z'),
    driverSession: {
      driver_id: 'drv-42',
      started_at: startedAt,
      session_id: sessionId,
      status: 'active',
    },
  });

  assert.deepEqual(withDriver.driver_session, {
    driver_id: 'drv-42',
    started_at: startedAt,
    session_id: sessionId,
    status: 'active',
  });
  assert.equal(validatePiTelemetryPacket(withDriver), null);

  const withoutDriver = buildTelemetryPacket({
    serial: 'pi-00000000-0000-0000-0000-000000000001',
    plate: 'ABC 1234',
    now: new Date('2026-11-20T09:02:00.500Z'),
    driverSession: null,
  });
  assert.equal('driver_session' in withoutDriver, false);
  assert.equal(validatePiTelemetryPacket(withoutDriver), null);

  const invalidSessionId = {
    ...withDriver,
    driver_session: { ...withDriver.driver_session, session_id: 'not-a-uuid' },
  };
  assert.equal(validatePiTelemetryPacket(invalidSessionId), 'invalid_pi_packet');
});

test('createDeviceApi.authenticateDriver POSTs to /api/v1/device/{id}/driver-auth with Bearer token and parses decision', async () => {
  const config = normalizeCommissioningConfig(readFileSync(DEVICE_JSON_PATH, 'utf8'));
  const api = createDeviceApi(config);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        status: 200,
        data: {
          decision: 'accepted',
          driver_id: 'drv-101',
          driver_display_name: 'Ahmad Razak',
          local_session_id: JSON.parse(init.body).local_session_id,
          shift_id: 'shift-77',
          valid_until: '2026-11-20T18:00:00Z',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const payload = {
      event_id: randomUUID(),
      local_session_id: randomUUID(),
      credential_type: 'nfc_uid_sha256',
      credential_fingerprint: hashNfcUid('04:A3:22:1B:5C:80:01'),
      occurred_at: '2026-11-20T09:01:37Z',
    };
    const res = await api.authenticateDriver(payload);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${config.api_url}/api/v1/device/${config.device_id}/driver-auth`,
    );
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${config.auth_token}`);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), payload);
    assert.equal(res.decision, 'accepted');
    assert.equal(res.driver_id, 'drv-101');
    assert.equal(res.shift_id, 'shift-77');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Rc522CardWatcher reads ISO 14443-A UID, hashes without exposing raw UID, debounces, and closes cleanly', async () => {
  const uidBytes = [0x04, 0xa3, 0x22, 0x1b];
  const bcc = uidBytes[0] ^ uidBytes[1] ^ uidBytes[2] ^ uidBytes[3];
  const expectedFingerprint = hashNfcUid('04A3221B');
  let closed = false;
  let nowMs = 1_795_165_297_000;
  const taps = [];

  const watcher = new Rc522CardWatcher({
    pollIntervalMs: 10,
    debounceMs: 5000,
    now: () => nowMs,
    onTap: (tap) => {
      taps.push(tap);
    },
    createReader: () => ({
      open() {},
      async readReg(reg) {
        assert.equal(reg, 0x37);
        return 0x92;
      },
      async init() {},
      async requestA() {
        return true;
      },
      async calcCrc() {
        return Buffer.from([0x00, 0x00]);
      },
      async transceive(buf) {
        if (buf[0] === 0x93 && buf[1] === 0x20) {
          return { data: Buffer.from([...uidBytes, bcc]), rxLastBits: 0 };
        }
        return { data: Buffer.from([0x08, 0x00, 0x00]), rxLastBits: 0 };
      },
      close() {
        closed = true;
      },
    }),
  });

  await watcher.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(taps.length, 1);
  assert.equal(taps[0].fingerprint, expectedFingerprint);
  assert.equal('uid' in taps[0], false);

  // Advance past debounce window and verify second tap emits
  nowMs += 5500;
  await new Promise((r) => setTimeout(r, 30));
  await watcher.stop();

  assert.ok(taps.length >= 2);
  assert.equal(closed, true);
});

test('Rc522CardWatcher resets debounce immediately once the card is removed and tapped again', async () => {
  const uidBytes = [0x04, 0xa3, 0x22, 0x1b];
  const bcc = uidBytes[0] ^ uidBytes[1] ^ uidBytes[2] ^ uidBytes[3];
  let present = true;
  const taps = [];

  const watcher = new Rc522CardWatcher({
    pollIntervalMs: 10,
    debounceMs: 60_000,
    onTap: (tap) => {
      taps.push(tap);
    },
    createReader: () => ({
      open() {},
      async readReg() {
        return 0x92;
      },
      async init() {},
      async requestA() {
        return present;
      },
      async calcCrc() {
        return Buffer.from([0x00, 0x00]);
      },
      async transceive(buf) {
        if (buf[0] === 0x93 && buf[1] === 0x20) {
          return { data: Buffer.from([...uidBytes, bcc]), rxLastBits: 0 };
        }
        return { data: Buffer.from([0x08, 0x00, 0x00]), rxLastBits: 0 };
      },
      close() {},
    }),
  });

  await watcher.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(taps.length, 1);

  // Lift card (at least 2 missed polls), then tap again well inside the 60s debounce window
  present = false;
  await new Promise((r) => setTimeout(r, 45));
  present = true;
  await new Promise((r) => setTimeout(r, 40));
  await watcher.stop();

  assert.equal(taps.length >= 2, true);
});

const execFileAsync = promisify(execFile);

test('createDeviceApi.settings GETs /api/v1/device/{id}/settings with Bearer token and sanitizeRuntimeSettings handles nested & flat state', async () => {
  const config = normalizeCommissioningConfig(readFileSync(DEVICE_JSON_PATH, 'utf8'));
  const api = createDeviceApi(config);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        status: 200,
        data: {
          version: 4,
          settings: {
            telemetry_interval_seconds: 12,
            cellular_enabled: true,
            safety_enabled: false,
            harsh_braking_ms2: 4.5,
            rapid_acceleration_ms2: 3.8,
            sharp_cornering_ms2: 5.0,
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const synced = await api.settings({ timeoutMs: 3000 });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${config.api_url}/api/v1/device/${config.device_id}/settings`,
    );
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${config.auth_token}`);

    const fromNested = sanitizeRuntimeSettings(synced);
    assert.equal(fromNested.settings_version, 4);
    assert.equal(fromNested.telemetry_interval_seconds, 12);
    assert.equal(fromNested.cellular_enabled, true);
    assert.equal(fromNested.safety_enabled, false);
    assert.deepEqual(fromNested.thresholds, {
      harsh_braking: 4.5,
      rapid_acceleration: 3.8,
      sharp_cornering: 5.0,
    });

    const tmp = mkdtempSync(join(tmpdir(), 'carlink-state-'));
    try {
      const statePath = join(tmp, '.telemetry-state.json');
      saveRuntimeState({ plate: 'ABC 1234', serial: 'pi-test', ...fromNested }, statePath);
      const restored = sanitizeRuntimeSettings(loadRuntimeState(statePath));
      assert.deepEqual(restored, fromNested);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CommandPoller auto-syncs when settings_version changes, skips unchanged versions, and retries after transient errors', async () => {
  const config = normalizeCommissioningConfig(readFileSync(DEVICE_JSON_PATH, 'utf8'));
  let serverVersion = 2;
  let failSettings = false;
  let pendingFetches = 0;
  let settingsFetches = 0;
  const applied = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/commands')) {
      pendingFetches++;
      return new Response(
        JSON.stringify({
          status: 200,
          data: { items: [], settings_version: serverVersion },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/settings')) {
      settingsFetches++;
      if (failSettings) {
        return new Response(JSON.stringify({ status: 503, message: 'unavailable' }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          status: 200,
          data: {
            version: serverVersion,
            settings: {
              telemetry_interval_seconds: serverVersion === 2 ? 8 : 15,
              cellular_enabled: serverVersion === 2,
              safety_enabled: true,
              harsh_braking_ms2: serverVersion === 2 ? 3.2 : 4.2,
              rapid_acceleration_ms2: 3.4,
              sharp_cornering_ms2: 3.9,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const poller = new CommandPoller(config, {}, {
      initialSettingsVersion: 2,
      onConfiguration: async (payload) => {
        applied.push(payload);
      },
    });

    // Version matches initialSettingsVersion (2) -> no /settings fetch
    await poller.pollOnce();
    assert.equal(pendingFetches, 1);
    assert.equal(settingsFetches, 0);
    assert.equal(applied.length, 0);

    // Server bumps to version 3, but /settings transiently fails -> retries on next poll
    serverVersion = 3;
    failSettings = true;
    await poller.pollOnce();
    assert.equal(settingsFetches, 1);
    assert.equal(applied.length, 0);
    assert.equal(poller.lastSettingsVersion, 2);

    // Recovery on next poll -> applies version 3 and updates lastSettingsVersion
    failSettings = false;
    await poller.pollOnce();
    assert.equal(settingsFetches, 2);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].version, 3);
    assert.equal(applied[0].settings.telemetry_interval_seconds, 15);
    assert.equal(applied[0].settings.harsh_braking_ms2, 4.2);
    assert.equal(poller.lastSettingsVersion, 3);

    // Subsequent poll at version 3 -> no redundant /settings fetch
    await poller.pollOnce();
    assert.equal(settingsFetches, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncBootSettings updates runtime settings on boot, falls back cleanly when offline, and CLI --interval works in dry-run', async () => {
  let runtime = sanitizeRuntimeSettings({
    settings_version: 1,
    telemetry_interval_seconds: 5,
    cellular_enabled: true,
    safety_enabled: true,
    thresholds: { harsh_braking: 3.0, rapid_acceleration: 3.0, sharp_cornering: 3.5 },
  });

  const applyConfiguration = async (parameters, version = null) => {
    const nextSettings = parameters?.settings ?? parameters;
    const nextVersion = version ?? parameters?.version ?? null;
    runtime = sanitizeRuntimeSettings(
      { ...runtime, ...nextSettings, ...(nextVersion ? { settings_version: nextVersion } : {}) },
      runtime,
    );
  };

  // Online boot sync updates all fields
  const ok = await syncBootSettings(
    {
      settings: async () => ({
        version: 5,
        settings: {
          telemetry_interval_seconds: 14,
          cellular_enabled: false,
          safety_enabled: false,
          harsh_braking_ms2: 5.5,
          rapid_acceleration_ms2: 4.8,
          sharp_cornering_ms2: 6.0,
        },
      }),
    },
    applyConfiguration,
  );
  assert.equal(ok, true);
  assert.equal(runtime.settings_version, 5);
  assert.equal(runtime.telemetry_interval_seconds, 14);
  assert.equal(runtime.cellular_enabled, false);
  assert.equal(runtime.safety_enabled, false);
  assert.deepEqual(runtime.thresholds, {
    harsh_braking: 5.5,
    rapid_acceleration: 4.8,
    sharp_cornering: 6.0,
  });

  // Offline boot failure keeps cached settings without throwing
  const offline = await syncBootSettings(
    {
      settings: async () => {
        throw new Error('network_unreachable');
      },
    },
    applyConfiguration,
  );
  assert.equal(offline, false);
  assert.equal(runtime.settings_version, 5);
  assert.equal(runtime.telemetry_interval_seconds, 14);

  // CLI smoke check with --interval and --dry-run
  const cliTmp = mkdtempSync(join(tmpdir(), 'carlink-cli-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(AGENT_DIR, 'index.js'),
        '--config',
        DEVICE_JSON_PATH,
        '--plate',
        'ABC 1234',
        '--interval',
        '10',
        '--dry-run',
        '--no-peripherals',
        '--no-modem',
        '--no-obd',
        '--count',
        '1',
      ],
      {
        timeout: 10_000,
        env: { ...process.env, CARLINK_STATE_PATH: join(cliTmp, '.telemetry-state.json') },
      },
    );
    assert.match(stdout, /interval=10s/);
    assert.match(stdout, /"message_type":"telemetry"/);
  } finally {
    rmSync(cliTmp, { recursive: true, force: true });
  }
});

test('pidReplies parses ATH1 headers across CAN 11-bit, 29-bit, ISO 9141, and KWP frames', () => {
  assert.equal(pidReplies('41 0D 00\r>', '0D', 1)[0]?.[0], 0);
  assert.equal(pidReplies('7E8 03 41 0D 12 AA AA AA AA\r>', '0D', 1)[0]?.[0], 0x12);
  assert.equal(pidReplies('18DAF110 03 41 0D 25\r>', '0D', 1)[0]?.[0], 0x25);
  assert.equal(pidReplies('48 6B 10 41 0D 00 C4\r>', '0D', 1)[0]?.[0], 0);
  assert.equal(pidReplies('83 F1 10 02 41 0D 0A CS\r>'.replace('CS', ''), '0D', 1)[0]?.[0], 0x0a);
});

test('AtModem.dispose, closePort, and closeNmea detach listeners and destroy closed/errored ports', async () => {
  const { EventEmitter } = await import('node:events');

  const createMockPort = (isOpen) => {
    const emitter = new EventEmitter();
    emitter.path = '/dev/ttyUSB5';
    emitter.isOpen = isOpen;
    emitter.destroyed = false;
    emitter.unpiped = [];
    emitter.write = (_data, cb) => cb?.(null);
    emitter.close = (cb) => {
      emitter.isOpen = false;
      cb?.(null);
    };
    emitter.unpipe = (target) => {
      emitter.unpiped.push(target);
    };
    emitter.destroy = () => {
      emitter.destroyed = true;
    };
    return emitter;
  };

  // Closed/errored port must still have AtModem listeners detached and destroy() invoked
  const deadPort = createMockPort(false);
  const modem = new AtModem(deadPort, 5000);
  assert.equal(deadPort.listenerCount('data'), 1);
  assert.equal(deadPort.listenerCount('error'), 1);
  assert.equal(deadPort.listenerCount('close'), 1);

  const openPort = createMockPort(true);
  const activeModem = new AtModem(openPort, 5000);
  const pendingCmd = activeModem.command('AT+CPSI?');
  activeModem.dispose(new Error('Disposed during rotation'));
  await assert.rejects(pendingCmd, /Disposed during rotation/);
  assert.equal(openPort.listenerCount('data'), 0);
  assert.equal(openPort.listenerCount('error'), 0);
  assert.equal(openPort.listenerCount('close'), 0);

  modem.dispose();
  assert.equal(deadPort.listenerCount('data'), 0);
  await closePort(deadPort);
  assert.equal(deadPort.destroyed, true);

  await closePort(openPort);
  assert.equal(openPort.isOpen, false);
  assert.equal(openPort.destroyed, true);

  // closeNmea unpipes, removes parser listeners, and destroys parser + port
  const nmeaPort = createMockPort(true);
  const parser = new EventEmitter();
  parser.destroyed = false;
  parser.on('data', () => {});
  parser.destroy = () => {
    parser.destroyed = true;
  };
  await closeNmea({ port: nmeaPort, parser, reports: new NmeaReports() });
  assert.deepEqual(nmeaPort.unpiped, [parser]);
  assert.equal(parser.listenerCount('data'), 0);
  assert.equal(parser.destroyed, true);
  assert.equal(nmeaPort.destroyed, true);
});

test('orderAtCandidates keeps free secondary AT ports ahead of ModemManager primary port even when deprioritized', () => {
  const ports = [
    { path: '/dev/ttyUSB0', usbInterfaceNumber: 0 },
    { path: '/dev/ttyUSB1', usbInterfaceNumber: 1 },
    { path: '/dev/ttyUSB4', usbInterfaceNumber: 2 },
    { path: '/dev/ttyUSB5', usbInterfaceNumber: 3 },
  ];
  const busyPorts = new Map([
    ['/dev/ttyUSB4', ['ModemManager primary-port', 'open by ModemManager(812)']],
  ]);
  const ranked = rankAtCandidates(ports, {
    busyPorts,
    mmInfo: {
      primaryPorts: new Set(['/dev/ttyUSB4']),
      mmAtPorts: new Set(['/dev/ttyUSB4', '/dev/ttyUSB5']),
      mmGpsPorts: new Set(['/dev/ttyUSB1']),
    },
  });

  // Even after /dev/ttyUSB5 failed twice (deprioritizePath), do not rotate into ModemManager primary /dev/ttyUSB4
  const ordered = orderAtCandidates(ranked, '/dev/ttyUSB5');
  assert.deepEqual(
    ordered.map((c) => c.path),
    ['/dev/ttyUSB5'],
  );

  // When two free candidates exist, deprioritizePath moves behind the other free candidate only
  const twoFreeRanked = rankAtCandidates(
    [
      ...ports,
      { path: '/dev/ttyUSB6', usbInterfaceNumber: 4 },
    ],
    {
      busyPorts,
      mmInfo: {
        primaryPorts: new Set(['/dev/ttyUSB4']),
        mmAtPorts: new Set(['/dev/ttyUSB4', '/dev/ttyUSB5']),
        mmGpsPorts: new Set(['/dev/ttyUSB1']),
      },
    },
  );
  const twoFreeOrdered = orderAtCandidates(twoFreeRanked, '/dev/ttyUSB5');
  assert.deepEqual(
    twoFreeOrdered.map((c) => c.path),
    ['/dev/ttyUSB6', '/dev/ttyUSB5'],
  );
});

test('appendObdLogEntry and pruneObdLog write raw OBD2 data with timestamp and MAC and enforce 4-hour retention', () => {
  assert.equal(DEFAULT_OBD_LOG_PATH, join(AGENT_DIR, 'OBD2.log'));
  assert.equal(DEFAULT_OBD_LOG_RETENTION_MS, 4 * 60 * 60 * 1000);

  const tmp = mkdtempSync(join(tmpdir(), 'carlink-obd-log-'));
  try {
    const logPath = join(tmp, 'OBD2.log');
    const nowMs = Date.parse('2026-11-25T21:45:00.000Z');
    const expiredTs = new Date(nowMs - DEFAULT_OBD_LOG_RETENTION_MS - 60_000).toISOString();
    const boundaryTs = new Date(nowMs - DEFAULT_OBD_LOG_RETENTION_MS + 60_000).toISOString();
    const recentTs = new Date(nowMs).toISOString();

    appendObdLogEntry(
      {
        timestamp: expiredTs,
        mac: '11:22:33:44:55:66',
        identity: 'ELM327 v1.5',
        supportedMask: 0xbe3ea813,
        raw: { '010C': '7E8 04 41 0C 0F A0\r>', '010D': '7E8 03 41 0D 28\r>' },
        vehicle: { engine_rpm: 1000, speed_kmh: 40 },
        dtcCodes: [],
      },
      { logPath, nowMs: Date.parse(expiredTs) },
    );

    appendObdLogEntry(
      {
        timestamp: boundaryTs,
        mac: '11:22:33:44:55:66',
        identity: 'ELM327 v1.5',
        supportedMask: 0xbe3ea813,
        raw: { '010C': '7E8 04 41 0C 1A F8\r>', ATRV: '13.9V\r>' },
        vehicle: { engine_rpm: 1726, ecu_voltage_v: 13.9 },
        dtcCodes: [],
      },
      { logPath, nowMs: Date.parse(boundaryTs) },
    );

    appendObdLogEntry(
      {
        timestamp: recentTs,
        mac: '11:22:33:44:55:66',
        identity: 'ELM327 v1.5',
        supportedMask: 0xbe3ea813,
        raw: { '010C': '7E8 04 41 0C 1E 00\r>', '03': '43 01 04 20\r>' },
        vehicle: { engine_rpm: 1920, mil_on: true },
        dtcCodes: ['P0420'],
      },
      { logPath, nowMs, forcePrune: true },
    );

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line.includes('mac=11:22:33:44:55:66')));
    assert.equal(lines[0].startsWith(`${boundaryTs} | mac=11:22:33:44:55:66 | `), true);
    assert.equal(lines[1].startsWith(`${recentTs} | mac=11:22:33:44:55:66 | `), true);

    const parsedLatest = JSON.parse(lines[1].split(' | ').slice(2).join(' | '));
    assert.equal(parsedLatest.timestamp, recentTs);
    assert.equal(parsedLatest.mac, '11:22:33:44:55:66');
    assert.equal(parsedLatest.raw['010C'], '7E8 04 41 0C 1E 00\r>');
    assert.equal(parsedLatest.raw['03'], '43 01 04 20\r>');
    assert.deepEqual(parsedLatest.dtc_codes, ['P0420']);

    // Pruning further in the future leaves only entries still within the 4-hour window
    const remaining = pruneObdLog(logPath, {
      retentionMs: DEFAULT_OBD_LOG_RETENTION_MS,
      nowMs: nowMs + 120_000,
    });
    assert.equal(remaining, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
