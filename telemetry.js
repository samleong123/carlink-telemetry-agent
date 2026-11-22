import { randomUUID } from 'node:crypto';
import { emptyVehicleSnapshot } from './obd.js';
import { formatGpsForServer, formatNetworkForServer } from './modem.js';
import { evaluateDrivingBehaviour } from './peripherals.js';

export const EDGE_VERSION = 'telemetry-agent-1.0.0';
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toWholeSecondUtc(dateOrMs = new Date()) {
  const date = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildTelemetryPacket({
  serial,
  plate,
  edgeVersion = EDGE_VERSION,
  now = new Date(),
  network = null,
  gps = null,
  vehicle = null,
  drivingBehaviour = null,
  deviceHealth = null,
  driverSession = null,
}) {
  const timestamp = toWholeSecondUtc(now);
  const netObj = network ?? formatNetworkForServer(null, null);
  const gpsObj = gps ?? formatGpsForServer(null, timestamp);
  const vehObj = vehicle ?? emptyVehicleSnapshot();
  const behObj = drivingBehaviour ?? evaluateDrivingBehaviour([], null, true);

  // Strip any unexpected dtc_codes property if passed from an upstream vehicle snapshot.
  const { dtc_codes: _ignoredDtcCodes, ...cleanVehicle } = vehObj;

  const healthObj = deviceHealth ?? {
    cpu_temp_c: null,
    cpu_usage_pct: null,
    memory_usage_pct: null,
    disk_usage_pct: null,
    uptime_s: 0,
    ble_obd_connected: Boolean(cleanVehicle.obd_connected),
    lte_connected: Boolean(netObj.connected),
    pending_records: 0,
    last_sync_at: null,
  };

  const packet = {
    message_type: 'telemetry',
    event_id: randomUUID(),
    timestamp,
    gateway: {
      device_id: serial,
      vehicle_id: plate,
      edge_version: edgeVersion,
    },
    network: netObj,
    gps: gpsObj,
    vehicle: cleanVehicle,
    driving_behaviour: behObj,
    device_health: healthObj,
  };

  if (
    driverSession &&
    driverSession.status === 'active' &&
    typeof driverSession.session_id === 'string' &&
    UUID_RE.test(driverSession.session_id)
  ) {
    packet.driver_session = {
      driver_id: String(driverSession.driver_id || 'authorized').slice(0, 160),
      started_at: toWholeSecondUtc(driverSession.started_at ?? now),
      session_id: driverSession.session_id,
      status: 'active',
    };
  }

  return packet;
}

const NUMBER_BOUNDS = {
  gps: {
    latitude: [-90, 90],
    longitude: [-180, 180],
    altitude_m: [-1000, 20000],
    speed_kmh: [0, 250],
    heading_deg: [0, 360],
    satellites: [0, 100],
    hdop: [0, 100],
  },
  vehicle: {
    engine_rpm: [0, 20000],
    speed_kmh: [0, 250],
    coolant_temp_c: [-40, 215],
    engine_load_pct: [0, 100],
    throttle_pct: [0, 100],
    intake_temp_c: [-40, 215],
    maf_gps: [0, 1000],
    fuel_rate_lph: [0, 1000],
    fuel_level_pct: [0, 100],
    odometer_km: [0, 10000000],
    engine_runtime_s: [0, 4294967295],
    ecu_voltage_v: [0, 100],
  },
  network: {
    lte_band: [0, 1000],
    earfcn: [0, 4000000],
    pci: [0, 1007],
    rssi_dbm: [-150, 0],
    rsrp_dbm: [-160, -20],
    rsrq_db: [-50, 10],
    sinr_db: [-30, 50],
  },
  device_health: {
    cpu_temp_c: [-40, 150],
    cpu_usage_pct: [0, 100],
    memory_usage_pct: [0, 100],
    disk_usage_pct: [0, 100],
    uptime_s: [0, 4294967295],
    pending_records: [0, 10000000],
  },
  'driving_behaviour.acceleration': {
    x_mps2: [-200, 200],
    y_mps2: [-200, 200],
    z_mps2: [-200, 200],
  },
  'driving_behaviour.gyroscope': {
    x_dps: [-4000, 4000],
    y_dps: [-4000, 4000],
    z_dps: [-4000, 4000],
  },
  'driving_behaviour.threshold': {
    harsh_braking: [0, 200],
    rapid_acceleration: [0, 200],
    sharp_cornering: [0, 200],
  },
  'vehicle.calculated_fuel_consumption': {
    rateLph: [0, 1000],
    instantL100km: [0, 1000000],
    totalLitres: [0, 100000000],
    distanceKm: [0, 100000000],
    averageL100km: [0, 1000000],
    averageKmPerL: [0, 1000000],
  },
};

const BOOLEAN_PATHS = [
  'gps.fix_valid',
  'vehicle.obd_connected',
  'vehicle.engine_running',
  'vehicle.mil_on',
  'vehicle.has_dtc_fault',
  'network.roaming',
  'network.connected',
  'device_health.ble_obd_connected',
  'device_health.lte_connected',
  'driving_behaviour.harsh_braking',
  'driving_behaviour.rapid_acceleration',
  'driving_behaviour.sharp_cornering',
];

const STRING_PATHS = [
  'network.modem_model',
  'network.imei',
  'network.imsi',
  'network.registered_plmn',
  'network.operator',
  'network.network_type',
  'network.registration_status',
  'network.cell_id',
  'network.tac',
  'driving_behaviour.sensor',
  'driver_session.driver_id',
];

const TIMESTAMP_PATHS = [
  'timestamp',
  'gps.timestamp',
  'driver_session.started_at',
  'driver_session.ended_at',
  'device_health.last_sync_at',
];

function getPath(obj, path) {
  return path.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

/** Local mirror of App\Services\Telemetry\PiTelemetryValidator::reason(). Returns null if valid. */
export function validatePiTelemetryPacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return 'invalid_pi_object';
  if (packet.message_type !== 'telemetry') return 'invalid_pi_packet';
  if (typeof packet.event_id !== 'string' || !UUID_RE.test(packet.event_id)) return 'invalid_pi_packet';
  if (typeof packet.timestamp !== 'string' || !UTC_SECOND_RE.test(packet.timestamp)) {
    return 'invalid_timestamp';
  }

  const topAllowed = new Set([
    'message_type',
    'event_id',
    'timestamp',
    'gateway',
    'network',
    'gps',
    'vehicle',
    'device_health',
    'driving_behaviour',
    'driver_session',
  ]);
  for (const key of Object.keys(packet)) {
    if (!topAllowed.has(key)) return 'unknown_pi_field';
  }

  const gw = packet.gateway;
  if (!gw || typeof gw !== 'object' || Array.isArray(gw)) return 'invalid_pi_object';
  for (const k of Object.keys(gw)) {
    if (!['device_id', 'vehicle_id', 'edge_version'].includes(k)) return 'unknown_pi_field';
  }
  if (
    typeof gw.device_id !== 'string' ||
    !gw.device_id.length ||
    gw.device_id.length > 160 ||
    typeof gw.vehicle_id !== 'string' ||
    !gw.vehicle_id.length ||
    gw.vehicle_id.length > 32 ||
    typeof gw.edge_version !== 'string' ||
    !gw.edge_version.length ||
    gw.edge_version.length > 100
  ) {
    return 'invalid_pi_packet';
  }

  for (const [objPath, bounds] of Object.entries(NUMBER_BOUNDS)) {
    const target = getPath(packet, objPath);
    if (target === undefined || target === null) continue;
    if (typeof target !== 'object' || Array.isArray(target)) return 'invalid_pi_object';
    for (const [key, [min, max]] of Object.entries(bounds)) {
      const v = target[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
        return `invalid_pi_number:${objPath}.${key}`;
      }
    }
  }

  for (const boolPath of BOOLEAN_PATHS) {
    const v = getPath(packet, boolPath);
    if (v !== undefined && v !== null && typeof v !== 'boolean') {
      return `invalid_pi_boolean:${boolPath}`;
    }
  }

  for (const strPath of STRING_PATHS) {
    const v = getPath(packet, strPath);
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 160)) {
      return `invalid_pi_string:${strPath}`;
    }
  }

  for (const tsPath of TIMESTAMP_PATHS) {
    const v = getPath(packet, tsPath);
    if (v !== undefined && v !== null && (typeof v !== 'string' || !UTC_SECOND_RE.test(v))) {
      return 'invalid_timestamp';
    }
  }

  const rateSource = getPath(packet, 'vehicle.calculated_fuel_consumption.rateSource');
  if (
    rateSource !== undefined &&
    rateSource !== null &&
    !['direct', 'maf', 'unknown'].includes(rateSource)
  ) {
    return 'invalid_pi_packet';
  }

  if (packet.gps?.fix_valid === true) {
    if (
      typeof packet.gps.latitude !== 'number' ||
      typeof packet.gps.longitude !== 'number' ||
      typeof packet.gps.timestamp !== 'string'
    ) {
      return 'invalid_pi_gps';
    }
  }

  if (packet.driver_session !== undefined && packet.driver_session !== null) {
    const ds = packet.driver_session;
    if (typeof ds !== 'object' || Array.isArray(ds)) {
      return 'invalid_pi_object';
    }
    if (
      ds.session_id !== undefined &&
      ds.session_id !== null &&
      (typeof ds.session_id !== 'string' || !UUID_RE.test(ds.session_id))
    ) {
      return 'invalid_pi_packet';
    }
    if (
      ds.status !== undefined &&
      ds.status !== null &&
      !['active', 'ended', 'inactive', 'unknown'].includes(ds.status)
    ) {
      return 'invalid_pi_packet';
    }
  }

  // Verify no unknown properties in nested objects
  const allowedNested = {
    network: [...Object.keys(NUMBER_BOUNDS.network), 'roaming', 'connected', 'modem_model', 'imei', 'imsi', 'registered_plmn', 'operator', 'network_type', 'registration_status', 'cell_id', 'tac'],
    gps: [...Object.keys(NUMBER_BOUNDS.gps), 'fix_valid', 'timestamp'],
    vehicle: [...Object.keys(NUMBER_BOUNDS.vehicle), 'obd_connected', 'engine_running', 'mil_on', 'has_dtc_fault', 'dtc_codes', 'calculated_fuel_consumption'],
    'vehicle.calculated_fuel_consumption': [...Object.keys(NUMBER_BOUNDS['vehicle.calculated_fuel_consumption']), 'rateSource'],
    device_health: [...Object.keys(NUMBER_BOUNDS.device_health), 'ble_obd_connected', 'lte_connected', 'last_sync_at'],
    driving_behaviour: ['sensor', 'acceleration', 'gyroscope', 'threshold', 'harsh_braking', 'rapid_acceleration', 'sharp_cornering'],
    'driving_behaviour.acceleration': Object.keys(NUMBER_BOUNDS['driving_behaviour.acceleration']),
    'driving_behaviour.gyroscope': Object.keys(NUMBER_BOUNDS['driving_behaviour.gyroscope']),
    'driving_behaviour.threshold': Object.keys(NUMBER_BOUNDS['driving_behaviour.threshold']),
    driver_session: ['driver_id', 'started_at', 'ended_at', 'session_id', 'status'],
  };
  for (const [objPath, keys] of Object.entries(allowedNested)) {
    const target = getPath(packet, objPath);
    if (!target || typeof target !== 'object') continue;
    for (const k of Object.keys(target)) {
      if (!keys.includes(k)) return `unknown_pi_field:${objPath}.${k}`;
    }
  }

  return null;
}
