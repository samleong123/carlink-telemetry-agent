import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = process.pkg ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_CANDIDATES = [
  join(AGENT_DIR, 'carlink-device.json'),
  join(AGENT_DIR, 'carlink-device.example.json'),
  '/etc/carlink/device.json',
];
export const DEFAULT_STATE_PATH = join(AGENT_DIR, '.telemetry-state.json');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAC_RE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

export const DEFAULT_RUNTIME_SETTINGS = {
  settings_version: null,
  telemetry_interval_seconds: 5,
  cellular_enabled: true,
  safety_enabled: true,
  thresholds: {
    harsh_braking: 3.0,
    rapid_acceleration: 3.0,
    sharp_cornering: 3.5,
  },
};

export function normalizeCommissioningConfig(rawInput) {
  const parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  const cfg = parsed?.data?.configuration ?? parsed?.configuration ?? parsed;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Commissioning JSON must be an object.');
  }

  const required = [
    'device_id',
    'organization_id',
    'obd_uuid',
    'obd_bluetooth_mac',
    'api_url',
    'broker_url',
    'broker_username',
    'auth_token',
  ];
  for (const key of required) {
    if (typeof cfg[key] !== 'string' || cfg[key].trim() === '') {
      throw new Error(`Missing or invalid required field: ${key}`);
    }
  }

  const out = {
    device_id: cfg.device_id.trim().toLowerCase(),
    organization_id: cfg.organization_id.trim().toLowerCase(),
    obd_uuid: cfg.obd_uuid.trim().toLowerCase(),
    obd_bluetooth_mac: cfg.obd_bluetooth_mac.trim().toUpperCase(),
    api_url: cfg.api_url.trim().replace(/\/$/, ''),
    broker_url: cfg.broker_url.trim(),
    broker_username: cfg.broker_username.trim(),
    auth_token: cfg.auth_token.trim().toLowerCase(),
  };

  for (const key of ['device_id', 'organization_id', 'obd_uuid']) {
    if (!UUID_RE.test(out[key])) {
      throw new Error(`Field ${key} must be a valid UUID.`);
    }
  }
  if (!MAC_RE.test(out.obd_bluetooth_mac)) {
    throw new Error('Field obd_bluetooth_mac must look like AA:BB:CC:DD:EE:FF.');
  }
  if (!TOKEN_RE.test(out.auth_token)) {
    throw new Error('Field auth_token must be a 64-character hex token.');
  }

  const expectedUser = 'd-' + out.device_id.replace(/-/g, '');
  if (out.broker_username !== expectedUser) {
    throw new Error(`Field broker_username (${out.broker_username}) must match ${expectedUser}.`);
  }

  const apiUrl = new URL(out.api_url);
  if (!['https:', 'http:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw new Error('Field api_url must be a valid HTTP/HTTPS URL without embedded credentials.');
  }

  const brokerUrl = new URL(out.broker_url);
  if (!['wss:', 'ws:', 'mqtts:'].includes(brokerUrl.protocol) || brokerUrl.username || brokerUrl.password) {
    throw new Error('Field broker_url must use wss://, ws://, or mqtts:// without embedded credentials.');
  }

  const optionalPlate = cfg.plate ?? cfg.vehicle_id;
  if (typeof optionalPlate === 'string' && optionalPlate.trim() !== '') {
    out.plate = normalizePlate(optionalPlate);
  }

  return out;
}

export function normalizePlate(plate) {
  const cleaned = String(plate || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!cleaned || cleaned.length > 32) {
    throw new Error('Vehicle plate must contain 1..32 alphanumeric characters (e.g. ABC 1234).');
  }
  return cleaned;
}

export function sanitizeRuntimeSettings(input, fallback = DEFAULT_RUNTIME_SETTINGS) {
  const fallbackVersion =
    Number.isInteger(fallback?.settings_version) && fallback.settings_version >= 1
      ? fallback.settings_version
      : null;
  const base = {
    settings_version: fallbackVersion,
    telemetry_interval_seconds: fallback.telemetry_interval_seconds,
    cellular_enabled: fallback.cellular_enabled,
    safety_enabled: fallback.safety_enabled,
    thresholds: { ...fallback.thresholds },
  };
  if (!input || typeof input !== 'object') return base;

  const src =
    input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
      ? input.settings
      : input;

  const versionCandidate = input.version ?? input.settings_version ?? src.version ?? src.settings_version;
  if (versionCandidate !== null && versionCandidate !== undefined) {
    const version = Number(versionCandidate);
    if (Number.isInteger(version) && version >= 1) {
      base.settings_version = version;
    }
  }

  const interval = Number(src.telemetry_interval_seconds);
  if (Number.isInteger(interval) && interval >= 2 && interval <= 30) {
    base.telemetry_interval_seconds = interval;
  }
  if (typeof src.cellular_enabled === 'boolean') {
    base.cellular_enabled = src.cellular_enabled;
  }
  if (typeof src.safety_enabled === 'boolean') {
    base.safety_enabled = src.safety_enabled;
  }

  const t = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : null;
  const harsh = Number(src.harsh_braking ?? src.harsh_braking_ms2 ?? t?.harsh_braking ?? t?.harsh_braking_ms2);
  if (Number.isFinite(harsh) && harsh >= 0.5 && harsh <= 200) {
    base.thresholds.harsh_braking = harsh;
  }
  const rapid = Number(
    src.rapid_acceleration ?? src.rapid_acceleration_ms2 ?? t?.rapid_acceleration ?? t?.rapid_acceleration_ms2,
  );
  if (Number.isFinite(rapid) && rapid >= 0.5 && rapid <= 200) {
    base.thresholds.rapid_acceleration = rapid;
  }
  const corner = Number(src.sharp_cornering ?? src.sharp_cornering_ms2 ?? t?.sharp_cornering ?? t?.sharp_cornering_ms2);
  if (Number.isFinite(corner) && corner >= 0.5 && corner <= 200) {
    base.thresholds.sharp_cornering = corner;
  }

  return base;
}

export function loadRuntimeState(statePath = DEFAULT_STATE_PATH) {
  try {
    if (!existsSync(statePath)) return {};
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRuntimeState(state, statePath = DEFAULT_STATE_PATH) {
  const dir = dirname(resolve(statePath));
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore chmod failures on non-POSIX filesystems
  }
  renameSync(tmpPath, statePath);
}

async function readStdinAll() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function resolveConfigPath(explicitPath) {
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (!existsSync(resolved)) {
      throw new Error(`Configuration file not found: ${resolved}`);
    }
    return resolved;
  }
  if (process.env.CARLINK_CONFIG) {
    const envPath = resolve(process.env.CARLINK_CONFIG);
    if (!existsSync(envPath)) {
      throw new Error(`CARLINK_CONFIG file not found: ${envPath}`);
    }
    return envPath;
  }
  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function loadAgentConfig(options = {}) {
  const statePath = options.statePath
    ? resolve(options.statePath)
    : process.env.CARLINK_STATE_PATH
      ? resolve(process.env.CARLINK_STATE_PATH)
      : DEFAULT_STATE_PATH;
  const state = loadRuntimeState(statePath);

  let rawJson = options.json ?? null;
  let configSource = null;

  if (rawJson) {
    configSource = 'inline-json';
  } else if (options.stdin) {
    rawJson = await readStdinAll();
    configSource = 'stdin';
  } else {
    const foundPath = resolveConfigPath(options.configPath);
    if (foundPath) {
      rawJson = readFileSync(foundPath, 'utf8');
      configSource = foundPath;
    } else if (!process.stdin.isTTY) {
      const stdinText = await readStdinAll();
      if (stdinText.trim()) {
        rawJson = stdinText;
        configSource = 'stdin';
      }
    }
  }

  let rl = null;
  if (!rawJson && process.stdin.isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('No carlink-device.json found. Paste commissioning JSON (Enter after closing }):');
    let acc = '';
    for await (const line of rl) {
      acc += `${line}\n`;
      const trimmed = acc.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          JSON.parse(trimmed);
          rawJson = trimmed;
          configSource = 'interactive-tty';
          break;
        } catch {
          // Wait for remaining lines
        }
      }
    }
  }

  if (!rawJson) {
    throw new Error(
      `No commissioning JSON found. Place carlink-device.json in ${AGENT_DIR}, pass --config <file>, or set CARLINK_CONFIG.`,
    );
  }

  const credentials = normalizeCommissioningConfig(rawJson);
  let plateCandidate =
    options.plate ||
    process.env.CARLINK_PLATE ||
    credentials.plate ||
    state.plate ||
    null;

  if (!plateCandidate && options.requirePlate !== false) {
    if (!process.stdin.isTTY) {
      rl?.close();
      throw new Error(
        'Vehicle plate is required on first run (e.g. --plate "ABC 1234" or CARLINK_PLATE="ABC 1234"). It will be saved to .telemetry-state.json for automatic restarts.',
      );
    }
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    plateCandidate = await rl.question('Vehicle plate registered in CarLink (e.g. ABC 1234): ');
  }
  rl?.close();

  const plate = plateCandidate ? normalizePlate(plateCandidate) : null;
  const serial = (options.serial || state.serial || `pi-${credentials.device_id}`).trim();
  const runtime = sanitizeRuntimeSettings(state);

  if (options.interval !== undefined) {
    runtime.telemetry_interval_seconds = sanitizeRuntimeSettings({
      telemetry_interval_seconds: options.interval,
    }, runtime).telemetry_interval_seconds;
  }

  // Persist plate/settings so systemd restarts or subsequent invocations are automatic.
  if (plate && (state.plate !== plate || state.serial !== serial || !state.thresholds)) {
    saveRuntimeState(
      {
        ...state,
        plate,
        serial,
        ...runtime,
        updated_at: new Date().toISOString(),
      },
      statePath,
    );
  }

  return {
    credentials,
    configSource,
    plate,
    serial,
    runtime,
    statePath,
  };
}
