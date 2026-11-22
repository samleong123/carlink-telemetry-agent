#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  loadAgentConfig,
  loadRuntimeState,
  sanitizeRuntimeSettings,
  saveRuntimeState,
} from './config.js';
import { CommandPoller, createDeviceApi, explainNormalDtcs } from './commands.js';
import { DeviceHealthMonitor } from './health.js';
import { listPortsReport, runModemCheck, Sim7600Watcher } from './modem.js';
import { ManagedMqttTransport } from './mqtt.js';
import { BleObdCollector, runObdCheck } from './obd.js';
import { I2cPeripherals, Rc522CardWatcher, validateRc522 } from './peripherals.js';
import {
  buildTelemetryPacket,
  EDGE_VERSION,
  toWholeSecondUtc,
  validatePiTelemetryPacket,
} from './telemetry.js';

const USAGE = `CarLink Orange Pi Zero 3 TelemetryAgent (${EDGE_VERSION})

Usage:
  node index.js [run|check|ports] [options]

Modes:
  run                   Start automated telemetry agent (default)
  check                 Verify OLED, MPU6050, RC522 (hardware only), and SIM7600G secondary AT port
  ports                 List serial devices, ModemManager primary ports, and ranked AT candidates

Options:
  --config, -c <file>   Path to carlink-device.json (defaults to ./carlink-device.json or /etc/carlink/device.json)
  --json,   -j <json>   Inline commissioning JSON string
  --stdin               Read commissioning JSON from stdin
  --plate,  -p <plate>  Vehicle plate registered in CarLink (saved after first run)
  --serial     <str>    Override gateway.device_id (defaults to pi-<device_id>)
  --interval,-i <sec>   Telemetry publish interval in seconds (2..30, default 5)
  --port       <path>   Explicit SIM7600G AT port override (otherwise skips ModemManager port)
  --baud       <rate>   Modem serial baud rate (default 115200)
  --obd-mac    <mac>    Override BLE OBD-II MAC address (e.g. 11:22:33:44:55:66)
  --ca         <file>   Optional custom CA PEM file for broker TLS/WSS
  --uid                 In check mode, wait up to 30s for one ISO 14443-A NFC card UID
  --no-obd              Disable BLE OBD-II collector
  --no-modem            Disable SIM7600G 4G/GPS modem collector
  --no-peripherals      Disable I2C3 (OLED/MPU6050) and SPI1 (RC522) hardware checks
  --dry-run             Print telemetry packets locally instead of connecting to MQTT/API
  --count,  -n <num>    Publish <num> packets then exit (0 = continuous, default 0)
  -h, --help            Show this help
`;

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      json: { type: 'string', short: 'j' },
      stdin: { type: 'boolean', default: false },
      plate: { type: 'string', short: 'p' },
      serial: { type: 'string' },
      interval: { type: 'string', short: 'i' },
      port: { type: 'string' },
      baud: { type: 'string', default: '115200' },
      'obd-mac': { type: 'string' },
      ca: { type: 'string' },
      uid: { type: 'boolean', default: false },
      'no-obd': { type: 'boolean', default: false },
      'no-modem': { type: 'boolean', default: false },
      'no-peripherals': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      count: { type: 'string', short: 'n', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const [mode = 'run'] = positionals;
  if (positionals.length > 1 || !['run', 'check', 'ports'].includes(mode)) {
    throw new Error(`Unknown mode "${positionals.join(' ')}". Expected run, check, or ports.`);
  }

  const baud = Number(values.baud);
  if (!Number.isInteger(baud) || baud < 1 || baud > 4_000_000) {
    throw new Error('--baud must be an integer between 1 and 4000000.');
  }

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('--count must be an integer >= 0.');
  }

  let interval;
  if (values.interval !== undefined) {
    interval = Number(values.interval);
    if (!Number.isInteger(interval) || interval < 2 || interval > 30) {
      throw new Error('--interval must be an integer between 2 and 30.');
    }
  }

  return {
    mode,
    configPath: values.config,
    json: values.json,
    stdin: values.stdin,
    plate: values.plate,
    serial: values.serial,
    interval,
    port: values.port,
    baud,
    obdMac: values['obd-mac'],
    caPath: values.ca,
    uid: values.uid,
    noObd: values['no-obd'],
    noModem: values['no-modem'],
    noPeripherals: values['no-peripherals'],
    dryRun: values['dry-run'],
    count,
  };
}

function formatOledDashboard({
  plate,
  mqttConnected,
  pendingRecords,
  publishedCount,
  ackCount,
  modemSnapshot,
  obdSnapshot,
  imuSample,
  rc522Status,
  driverSession = null,
  nfcStatusText = null,
}) {
  const net = modemSnapshot?.network;
  const gps = modemSnapshot?.gps;
  const veh = obdSnapshot?.vehicle;

  const line1 = `${(plate || 'CARLINK').slice(0, 8)} ${mqttConnected ? 'MQTT:OK' : `SPOOL:${pendingRecords}`}`;

  let line2 = '4G:OFFLINE';
  if (net) {
    const type = net.network_type || 'CELL';
    const sig =
      net.rsrp_dbm != null
        ? `${Math.round(net.rsrp_dbm)}dBm`
        : net.rssi_dbm != null
          ? `${Math.round(net.rssi_dbm)}dBm`
          : net.registration_status || 'WAIT';
    line2 = `4G:${type} ${sig}`;
  }

  const line3 = gps?.fix_valid
    ? `GPS:${gps.satellites ?? '?'}s ${Math.round(gps.speed_kmh ?? 0)}kmh`
    : 'GPS:NO FIX';

  const line4 = veh?.obd_connected
    ? `OBD:${veh.engine_rpm ?? 0}rpm ${veh.speed_kmh ?? 0}kmh`
    : 'OBD:STANDBY';

  const line5 = imuSample
    ? `IMU:Y${imuSample.acceleration.y_mps2.toFixed(1)} Z${imuSample.acceleration.z_mps2.toFixed(1)}`
    : 'IMU:UNAVAILABLE';

  let line6;
  if (nfcStatusText) {
    line6 = `${nfcStatusText} T:${publishedCount} A:${ackCount}`;
  } else if (driverSession?.status === 'active') {
    const rawName = String(driverSession.driver_display_name || driverSession.driver_id || 'Driver').trim();
    const firstName = (rawName.split(/\s+/)[0] || 'Driver').slice(0, 8);
    line6 = `DRV:${firstName} T:${publishedCount} A:${ackCount}`;
  } else {
    const nfcTag = rc522Status.ok ? rc522Status.version : 'ERR';
    line6 = `NFC:${nfcTag} T:${publishedCount} A:${ackCount}`;
  }

  return [line1, line2, line3, line4, line5, line6];
}

async function runCheckMode(opts) {
  let exitCode = 0;

  if (!opts.noPeripherals) {
    const i2c = new I2cPeripherals();
    try {
      await i2c.start();
      if (i2c.oledOk) {
        i2c.renderLines(['CARLINK CHECK', 'OLED: OK (0x3C)', 'Testing MPU/RC522...', '']);
        console.log('[CHECK] OLED OK (0x3C)');
      } else {
        console.error(`[CHECK] OLED FAILED: ${i2c.oledError || 'not detected'}`);
        exitCode = 1;
      }
      if (i2c.mpuOk) {
        const imu = i2c.peekLatestImu();
        console.log('[CHECK] MPU6050 OK (0x68):', JSON.stringify(imu));
      } else {
        console.error(`[CHECK] MPU6050 FAILED: ${i2c.mpuError || 'not detected'}`);
        exitCode = 1;
      }
    } catch (error) {
      console.error(`[CHECK] I2C3 FAILED: ${error.message}`);
      exitCode = 1;
    } finally {
      await i2c.stop();
    }

    try {
      const nfc = await validateRc522({ readTagUid: opts.uid });
      console.log(`[CHECK] RC522 OK - version ${nfc.version}${nfc.uid ? ` (Card UID: ${nfc.uid})` : ''}`);
    } catch (error) {
      console.error(`[CHECK] RC522 FAILED: ${error.message}`);
      exitCode = 1;
    }
  }

  if (!opts.noModem) {
    try {
      const modemResult = await runModemCheck({ portPath: opts.port, baudRate: opts.baud });
      console.log(
        `[CHECK] SIM7600G OK on ${modemResult.atPort} (model=${modemResult.details.model}, imei=${modemResult.details.imei}, operator=${modemResult.network.operator}, type=${modemResult.network.networkType}, gpsFix=${modemResult.gps.fix})`,
      );
      if (modemResult.busySkipped.length) {
        console.log(`[CHECK] Skipped busy/ModemManager ports: ${modemResult.busySkipped.join('; ')}`);
      }
    } catch (error) {
      console.error(`[CHECK] SIM7600G FAILED: ${error.message}`);
      exitCode = 1;
    }
  }

  let cfg = null;
  try {
    cfg = await loadAgentConfig({
      configPath: opts.configPath,
      json: opts.json,
      stdin: opts.stdin,
      plate: opts.plate,
      serial: opts.serial,
      requirePlate: false,
    });
    console.log(
      `[CHECK] Credentials OK (${cfg.configSource}): device_id=${cfg.credentials.device_id} broker=${cfg.credentials.broker_url} plate=${cfg.plate ?? '(unset)'}`,
    );
  } catch (error) {
    console.error(`[CHECK] Credentials WARNING: ${error.message}`);
  }

  if (!opts.noObd) {
    try {
      const targetMac = opts.obdMac || cfg?.credentials?.obd_bluetooth_mac;
      const obdRes = await runObdCheck({ mac: targetMac });
      console.log(
        `[CHECK] DUDU-OBD OK on ${obdRes.mac} (${obdRes.identity}, rpm=${obdRes.vehicle.engine_rpm ?? 'n/a'}, speed=${obdRes.vehicle.speed_kmh ?? 'n/a'}km/h, volt=${obdRes.vehicle.ecu_voltage_v ?? 'n/a'}V)`,
      );
    } catch (error) {
      console.error(`[CHECK] DUDU-OBD FAILED: ${error.message}`);
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

export async function syncBootSettings(deviceApi, applyConfiguration, { timeoutMs = 4000 } = {}) {
  if (!deviceApi?.settings) return false;
  try {
    const synced = await deviceApi.settings({ timeoutMs });
    if (synced?.settings) {
      await applyConfiguration(synced.settings, synced.version);
      return true;
    }
  } catch (error) {
    console.warn(`[CFG] Boot settings sync failed (${error.message}); using local/cached settings.`);
  }
  return false;
}

async function runAgentMode(opts) {
  const agentConfig = await loadAgentConfig({
    configPath: opts.configPath,
    json: opts.json,
    stdin: opts.stdin,
    plate: opts.plate,
    serial: opts.serial,
    interval: opts.interval,
    requirePlate: true,
  });

  const { credentials, configSource, plate, serial, statePath } = agentConfig;
  let runtime = agentConfig.runtime;
  const caPem = opts.caPath ? readFileSync(opts.caPath) : null;

  let i2c = null;
  let nfcWatcher = null;
  let modemWatcher = null;
  let obdCollector = null;
  let mqtt = null;
  let commandPoller = null;
  let activeDriverSession = null;
  let nfcFeedback = null;
  let publishedTicks = 0;
  let lastModemSnapshot = null;
  let lastObdSnapshot = null;
  let running = true;
  let shuttingDown = false;
  let stopResolve = null;
  const stoppedPromise = new Promise((res) => {
    stopResolve = res;
  });

  const deviceApi = !opts.dryRun ? createDeviceApi(credentials) : null;

  const getActiveDriverSession = (nowMs = Date.now()) => {
    if (!activeDriverSession || activeDriverSession.status !== 'active') return null;
    if (activeDriverSession.valid_until) {
      const validUntilMs = Date.parse(activeDriverSession.valid_until);
      if (Number.isFinite(validUntilMs) && nowMs >= validUntilMs) {
        console.log('[NFC] Driver session expired');
        activeDriverSession = null;
        return null;
      }
    }
    return activeDriverSession;
  };

  const cleanupAll = async () => {
    commandPoller?.stop();
    mqtt?.stop();
    await Promise.race([
      Promise.allSettled([
        nfcWatcher?.stop(),
        obdCollector?.stop(),
        modemWatcher?.stop(),
        i2c?.stop(),
      ]),
      sleep(1500),
    ]);
  };

  const shutdown = async (signalName) => {
    if (shuttingDown) {
      console.log(`\n[STOP] Second ${signalName} received; forcing immediate exit.`);
      process.exit(130);
    }
    shuttingDown = true;
    running = false;
    console.log(`\n[STOP] Received ${signalName}; shutting down cleanly...`);
    const forceTimer = setTimeout(() => {
      process.exit(0);
    }, 2000);
    forceTimer.unref?.();
    stopResolve?.();
    await cleanupAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`[INIT] TelemetryAgent ${EDGE_VERSION}`);
  console.log(`[INIT] Credentials: ${configSource}`);
  console.log(`[INIT] device_id=${credentials.device_id} org=${credentials.organization_id}`);
  console.log(`[INIT] serial=${serial} plate=${plate} obd_mac=${credentials.obd_bluetooth_mac}`);
  console.log(`[INIT] interval=${runtime.telemetry_interval_seconds}s dryRun=${opts.dryRun}`);

  // 1. Validate RC522 hardware presence
  let rc522Status = { ok: false, version: null, error: 'disabled' };
  if (!opts.noPeripherals && running) {
    try {
      const res = await validateRc522({ readTagUid: false });
      rc522Status = { ok: true, version: res.version, error: null };
      console.log(`[NFC] RC522 validated (${res.version})`);
    } catch (error) {
      rc522Status = { ok: false, version: null, error: error.message };
      console.warn(`[NFC] RC522 validation warning: ${error.message}`);
    }
  }

  // 2. Start I2C3 shared OLED + MPU6050
  if (!opts.noPeripherals && running) {
    i2c = new I2cPeripherals();
    try {
      await i2c.start();
      console.log(
        `[I2C3] OLED=${i2c.oledOk ? 'OK' : `ERR(${i2c.oledError})`} MPU6050=${i2c.mpuOk ? 'OK' : `ERR(${i2c.mpuError})`}`,
      );
    } catch (error) {
      console.warn(`[I2C3] Bus 3 unavailable (${error.message}); continuing without I2C peripherals.`);
      i2c = null;
    }
  }

  const renderOled = () => {
    if (!i2c?.oledOk) return;
    const nowMs = Date.now();
    const activeSession = getActiveDriverSession(nowMs);
    const nfcStatusText =
      nfcFeedback && nowMs < nfcFeedback.expiresAtMs ? nfcFeedback.text : null;
    if (nfcFeedback && nowMs >= nfcFeedback.expiresAtMs) {
      nfcFeedback = null;
    }
    i2c.renderLines(
      formatOledDashboard({
        plate,
        mqttConnected: mqtt?.connected ?? false,
        pendingRecords: mqtt?.pendingRecords ?? 0,
        publishedCount: mqtt?.publishedCount ?? publishedTicks,
        ackCount: mqtt?.ackCount ?? 0,
        modemSnapshot: lastModemSnapshot,
        obdSnapshot: lastObdSnapshot,
        imuSample: i2c.peekLatestImu(),
        rc522Status,
        driverSession: activeSession,
        nfcStatusText,
      }),
    );
  };

  // Start RC522 card tap watcher once OLED and deviceApi are ready
  if (!opts.noPeripherals && rc522Status.ok && running) {
    nfcWatcher = new Rc522CardWatcher({
      onTap: async ({ fingerprint, occurredAt }) => {
        if (!running) return;
        if (!deviceApi) {
          console.log('[NFC] Card tap detected in dry-run mode; skipping server auth.');
          return;
        }
        const event_id = randomUUID();
        const local_session_id = randomUUID();
        const occurred_at = occurredAt || toWholeSecondUtc();
        try {
          const res = await deviceApi.authenticateDriver({
            event_id,
            local_session_id,
            credential_type: 'nfc_uid_sha256',
            credential_fingerprint: fingerprint,
            occurred_at,
            action: 'toggle',
          });
          if (res?.decision === 'accepted') {
            activeDriverSession = {
              driver_id: res.driver_id || 'authorized',
              driver_display_name: res.driver_display_name || 'Driver',
              session_id: res.local_session_id || local_session_id,
              started_at: occurred_at,
              valid_until: res.valid_until || null,
              status: 'active',
            };
            nfcFeedback = null;
            console.log(`[NFC] Driver session started (shift=${res.shift_id ?? 'none'})`);
          } else if (res?.decision === 'signed_out') {
            activeDriverSession = null;
            nfcFeedback = { text: 'NFC:SIGNED OUT', expiresAtMs: Date.now() + 5000 };
            console.log(`[NFC] Driver session ended (shift=${res.shift_id ?? 'none'})`);
          } else {
            nfcFeedback = { text: 'NFC:DENIED', expiresAtMs: Date.now() + 5000 };
            console.warn(`[NFC] Driver auth rejected (decision=${res?.decision ?? 'unknown'})`);
          }
        } catch (error) {
          nfcFeedback = { text: 'NFC:DENIED', expiresAtMs: Date.now() + 5000 };
          console.warn(`[NFC] Driver auth failed: ${error.message}`);
        }
        renderOled();
      },
      onError: (error) => {
        console.warn(`[NFC] Watcher poll error: ${error.message}`);
      },
    });
    try {
      await nfcWatcher.start();
      console.log(`[NFC] Card watcher active (${nfcWatcher.version})`);
    } catch (error) {
      console.warn(`[NFC] Card watcher start warning: ${error.message}`);
      nfcWatcher = null;
    }
  }

  // 3. Start SIM7600G 4G/GPS watcher using secondary AT port (and auto-fallback/NMEA if unavailable)
  if (!opts.noModem && running) {
    modemWatcher = new Sim7600Watcher({ portPath: opts.port, baudRate: opts.baud });
    try {
      await modemWatcher.start();
      console.log(
        `[SIM7600G] Active on AT=${modemWatcher.atPortPath ?? 'retrying'} NMEA=${modemWatcher.nmeaPortPath ?? 'none'} model=${modemWatcher.modemModel}`,
      );
    } catch (error) {
      console.warn(
        `[SIM7600G] Initial start warning (${error.message}); keeping watcher active for automatic port recovery.`,
      );
    }
  }

  // 4. Start BLE OBD-II collector
  const applyConfiguration = async (parameters, version = null) => {
    const nextSettings =
      parameters?.settings && typeof parameters.settings === 'object' && !Array.isArray(parameters.settings)
        ? parameters.settings
        : parameters;
    const nextVersion = version ?? parameters?.version ?? parameters?.settings_version ?? null;
    const state = loadRuntimeState(statePath);
    runtime = sanitizeRuntimeSettings(
      {
        ...(nextSettings && typeof nextSettings === 'object' ? nextSettings : {}),
        ...(nextVersion !== null && nextVersion !== undefined ? { settings_version: nextVersion } : {}),
      },
      runtime,
    );
    saveRuntimeState({ ...state, plate, serial, ...runtime, updated_at: new Date().toISOString() }, statePath);
    console.log(
      `[CMD] Applied runtime configuration: version=${runtime.settings_version ?? 'local'} interval=${runtime.telemetry_interval_seconds}s cellular=${runtime.cellular_enabled} safety=${runtime.safety_enabled} thresholds=${JSON.stringify(runtime.thresholds)}`,
    );
  };

  const targetObdMac = opts.obdMac || credentials.obd_bluetooth_mac;
  obdCollector = new BleObdCollector({
    mac: targetObdMac,
    enabled: !opts.noObd,
    onConfigurationUpdate: applyConfiguration,
  });
  if (running) {
    await Promise.race([obdCollector.start(), stoppedPromise]);
  }

  // 5. Sync organization settings on boot, then connect MQTT & signed edge command poller
  if (!opts.dryRun && running) {
    await Promise.race([
      syncBootSettings(deviceApi, async (settings, version) => {
        if (running) await applyConfiguration(settings, version);
      }),
      stoppedPromise,
    ]);
    if (running) {
      mqtt = new ManagedMqttTransport(credentials, { caPem });
      await Promise.race([mqtt.start(), stoppedPromise]);
      commandPoller = new CommandPoller(credentials, obdCollector, {
        onConfiguration: applyConfiguration,
        initialSettingsVersion: runtime.settings_version,
        api: deviceApi,
      });
      commandPoller.start();
    }
  }

  const healthMonitor = new DeviceHealthMonitor();

  let lastPublishedEpochSec = 0;

  // Give BLE/I2C a brief moment for initial sample before first publish
  if (running) await Promise.race([sleep(300), stoppedPromise]);

  while (running && (opts.count === 0 || publishedTicks < opts.count)) {
    const intervalSec = runtime.telemetry_interval_seconds;
    const nowEpochSec = Math.floor(Date.now() / 1000);
    if (lastPublishedEpochSec > 0 && nowEpochSec < lastPublishedEpochSec + intervalSec) {
      const waitMs = (lastPublishedEpochSec + intervalSec) * 1000 - Date.now() + 25;
      if (waitMs > 0) await Promise.race([sleep(waitMs), stoppedPromise]);
      if (!running) break;
    }

    const packetDate = new Date();
    const packetEpochSec = Math.floor(packetDate.getTime() / 1000);
    if (packetEpochSec <= lastPublishedEpochSec) {
      await Promise.race([sleep(1000), stoppedPromise]);
      continue;
    }
    lastPublishedEpochSec = packetEpochSec;
    const stamp = toWholeSecondUtc(packetEpochSec * 1000);

    const modemSnapshot = modemWatcher?.getSnapshot(stamp) ?? null;
    const obdSnapshot = obdCollector.getSnapshot();
    lastModemSnapshot = modemSnapshot;
    lastObdSnapshot = obdSnapshot;
    const drivingBehaviour = i2c
      ? i2c.consumeDrivingBehaviour(runtime.thresholds, runtime.safety_enabled)
      : null;
    const deviceHealth = healthMonitor.sample({
      bleObdConnected: obdSnapshot.vehicle.obd_connected,
      lteConnected: modemSnapshot?.network.connected ?? false,
      pendingRecords: mqtt?.pendingRecords ?? 0,
      lastSyncAt: mqtt?.lastSyncAt ?? null,
    });

    const driverSession = getActiveDriverSession(packetEpochSec * 1000);
    const rawPacket = buildTelemetryPacket({
      serial,
      plate,
      now: packetEpochSec * 1000,
      network: modemSnapshot?.network ?? null,
      gps: modemSnapshot?.gps ?? null,
      vehicle: obdSnapshot.vehicle,
      drivingBehaviour,
      deviceHealth,
      driverSession,
    });

    // Never block telemetry generation on DTC-AI HTTP calls when offline or slow
    const { packet: sanitized } = await explainNormalDtcs(rawPacket, obdSnapshot.dtcCodes, null);
    if (!opts.dryRun && mqtt?.connected && obdSnapshot.dtcCodes?.length && commandPoller?.api) {
      void explainNormalDtcs(rawPacket, obdSnapshot.dtcCodes, commandPoller.api).catch(() => {});
    }

    const validationError = validatePiTelemetryPacket(sanitized);
    if (validationError) {
      console.error(`[WARN] Telemetry packet failed local schema check (${validationError}); skipping publish.`);
    } else if (opts.dryRun) {
      publishedTicks++;
      console.log(JSON.stringify(sanitized));
    } else {
      const res = mqtt.publishPacket(sanitized.event_id, JSON.stringify(sanitized));
      publishedTicks++;
      console.log(
        `[PUB #${publishedTicks}] ${res.queued ? 'spooled_offline' : `pkt=${res.packetId}`} event=${sanitized.event_id} unacked=${mqtt.pendingRecords} acks=${mqtt.ackCount} 4g=${sanitized.network.network_type ?? 'none'}(${sanitized.network.rsrp_dbm ?? '-'}dBm) gps=${sanitized.gps.fix_valid ? `${sanitized.gps.latitude},${sanitized.gps.longitude}` : 'no_fix'} obd=${sanitized.vehicle.obd_connected ? `${sanitized.vehicle.engine_rpm ?? 0}rpm` : 'off'}`,
      );
    }

    renderOled();

    if (opts.count !== 0 && publishedTicks >= opts.count) break;
    const nextWaitMs = Math.max(
      200,
      (lastPublishedEpochSec + runtime.telemetry_interval_seconds) * 1000 - Date.now() + 25,
    );
    await Promise.race([sleep(nextWaitMs), stoppedPromise]);
  }

  if (opts.count > 0 && !opts.dryRun && mqtt && running) {
    console.log('[WAIT] Waiting up to 4s for broker/application ACKs...');
    await Promise.race([sleep(4000), stoppedPromise]);
  }

  await cleanupAll();
  process.exit(0);
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.mode === 'ports') {
    const report = await listPortsReport();
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (opts.mode === 'check') {
    await runCheckMode(opts);
    return;
  }
  await runAgentMode(opts);
}

function isExecutedAsMain() {
  if (process.pkg) return true;
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return (
      process.argv[1] === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith('index.js') ||
      process.argv[1].endsWith('carlink-telemetry-agent')
    );
  }
}

if (isExecutedAsMain()) {
  main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
  });
}
