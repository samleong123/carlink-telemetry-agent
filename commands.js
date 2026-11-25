import { createHmac, timingSafeEqual } from 'node:crypto';
import { scanDtcs } from './dtc-scan.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[PCBU][0-3][0-9A-F]{3}$/;
const READ_ONLY_RE =
  /^(?:AT(?:D|E0|L0|S1|H[01]|AL|SP0|DP|DPN|CP18|SH[0-9A-F]{3,8})|010[0D]|03|07|0A|1802FF00|1902FF|1003|3E00)$/;

export function verifyCommand(item, config, now = Date.now()) {
  if (
    typeof item?.wire_payload !== 'string' ||
    Buffer.byteLength(item.wire_payload) > 32768 ||
    !/^[0-9a-f]{64}$/i.test(item?.signature || '')
  ) {
    throw new Error('invalid_signature');
  }
  const expected = createHmac('sha256', config.auth_token)
    .update(item.wire_payload, 'utf8')
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(item.signature, 'hex'))) {
    throw new Error('invalid_signature');
  }

  let cmd;
  try {
    cmd = JSON.parse(item.wire_payload);
  } catch {
    throw new Error('invalid_command');
  }

  if (
    !cmd ||
    !UUID_RE.test(cmd.id) ||
    !UUID_RE.test(cmd.vehicle_id) ||
    !UUID_RE.test(cmd.installation_id) ||
    cmd.device_id !== config.device_id ||
    cmd.organization_id !== config.organization_id ||
    !['extended_dtc', 'configuration'].includes(cmd.kind) ||
    !Number.isFinite(Date.parse(cmd.expires_at)) ||
    Date.parse(cmd.expires_at) <= now ||
    !Number.isFinite(Date.parse(cmd.issued_at)) ||
    Date.parse(cmd.issued_at) > now + 5000 ||
    Date.parse(cmd.issued_at) < now - 300_000 ||
    !cmd.parameters ||
    typeof cmd.parameters !== 'object' ||
    Array.isArray(cmd.parameters)
  ) {
    throw new Error('invalid_command');
  }

  if (
    cmd.kind === 'extended_dtc' &&
    (cmd.parameters.read_only !== true ||
      cmd.parameters.local_stationary_check_required !== true ||
      cmd.parameters.max_duration_seconds !== 300)
  ) {
    throw new Error('invalid_command');
  }

  if (cmd.kind === 'configuration') {
    const p = cmd.parameters;
    if (
      !Number.isInteger(p.telemetry_interval_seconds) ||
      p.telemetry_interval_seconds < 2 ||
      p.telemetry_interval_seconds > 30 ||
      typeof p.cellular_enabled !== 'boolean' ||
      typeof p.safety_enabled !== 'boolean'
    ) {
      throw new Error('invalid_configuration');
    }
  }

  return cmd;
}

export function requireStationary(reading, now = Date.now()) {
  if (
    !reading ||
    reading.source !== 'obd_pid_010d' ||
    typeof reading.speed_kmh !== 'number' ||
    reading.speed_kmh !== 0 ||
    !Number.isFinite(Date.parse(reading.observed_at)) ||
    Date.parse(reading.observed_at) > now ||
    now - Date.parse(reading.observed_at) > 2000
  ) {
    throw new Error('not_stationary');
  }
}

export async function executeCommand(
  cmd,
  adapter,
  api,
  { scanner = scanDtcs, now = Date.now, maximumMs = 300_000 } = {},
) {
  if (maximumMs < 1 || maximumMs > 300_000) throw new Error('invalid_deadline');
  const controller = new AbortController();
  const deadline = now() + maximumMs;
  const timer = setTimeout(() => controller.abort(), maximumMs);
  timer.unref?.();

  let status = 'transport_failed';
  let report = null;

  try {
    await adapter.withExclusiveObd(
      async () => {
        try {
          await adapter.pauseTelemetry({ signal: controller.signal });
          if (cmd.kind === 'configuration') {
            await api.result(cmd.id, { state: 'running', result_status: 'started' });
            await adapter.applyConfiguration(cmd.parameters, { signal: controller.signal });
            status = 'completed';
            return;
          }
          const speed = await adapter.readObdSpeed({ signal: controller.signal });
          requireStationary(speed, now());
          await api.result(cmd.id, {
            state: 'running',
            result_status: 'started',
            speed_kmh: 0,
            speed_observed_at: speed.observed_at,
          });
          const send = async (elm, command, timeout = 8000) => {
            if (!READ_ONLY_RE.test(command)) throw new Error('unsupported');
            if (controller.signal.aborted || now() >= deadline) throw new Error('timed_out');
            requireStationary(
              await adapter.readObdSpeed({
                signal: controller.signal,
                preserveDiagnosticState: true,
              }),
              now(),
            );
            return adapter.send(command, {
              timeoutMs: Math.min(timeout, deadline - now()),
              signal: controller.signal,
            });
          };
          report = await scanner(adapter, send, { extended: true });
          status = [3, 4, 5, 6, 7, 8, 9].includes(Number(report.protocol?.number))
            ? 'completed'
            : 'unsupported';
        } finally {
          try {
            await adapter.restoreBaseline({ signal: AbortSignal.timeout(10_000) });
          } finally {
            await adapter.resumeTelemetry({ signal: AbortSignal.timeout(10_000) });
          }
        }
      },
      { signal: controller.signal },
    );
  } catch (error) {
    console.error(`[CMD] Command id=${cmd.id} (${cmd.kind}) error: ${error.message}`);
    status = controller.signal.aborted
      ? 'timed_out'
      : ['not_stationary', 'unsupported', 'timed_out'].includes(error.message)
        ? error.message
        : 'transport_failed';
  } finally {
    clearTimeout(timer);
  }

  if (status === 'completed' && cmd.kind === 'extended_dtc' && report) {
    const codes = new Set();
    for (const attempt of report.attempts || []) {
      for (const response of attempt.responses || []) {
        for (const dtc of response.dtcs || []) {
          if (CODE_RE.test(dtc.code)) codes.add(dtc.code);
        }
      }
    }
    try {
      for (const code of [...codes].slice(0, 32)) {
        try {
          const explanation = await api.explain(code);
          await adapter.onExplanation?.(explanation);
        } catch {
          // Transient AI failure never blocks command completion
        }
      }
    } finally {
      codes.clear();
      report = null;
    }
  }

  await api.result(cmd.id, {
    state: status === 'completed' ? 'completed' : 'failed',
    result_status: status,
  });
  return status;
}

export function createDeviceApi(config) {
  const origin = new URL(config.api_url);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('invalid_endpoint');
  }
  const root = `${config.api_url.replace(/\/$/, '')}/api/v1/device/${config.device_id}`;

  async function request(path, body, { timeoutMs = 15_000 } = {}) {
    const response = await fetch(root + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.auth_token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`api_rejected_${response.status}`);
    const raw = await response.text();
    if (raw.length > 1_048_576) throw new Error('invalid_response');
    const envelope = JSON.parse(raw);
    if (envelope.status !== response.status || !envelope.data) {
      throw new Error('invalid_response');
    }
    return envelope.data;
  }

  return {
    pending: () => request('/commands'),
    settings: (opts) => request('/settings', undefined, opts),
    result: (id, body) => request(`/commands/${id}/result`, body),
    explain: (code) => request('/dtc-ai', { code }),
    authenticateDriver: (payload) => request('/driver-auth', payload),
  };
}

/**
 * Preserves normalized `vehicle.dtc_codes` and `vehicle.has_dtc_fault`, scrubs internal
 * AI/raw-scan fields, and sends up to 10 unique normal codes ephemerally to `/dtc-ai`.
 */
export async function explainNormalDtcs(packet, rawCodes = [], api = null, onExplanation = null) {
  const codes = [
    ...new Set(
      (rawCodes || [])
        .filter((c) => typeof c === 'string')
        .map((c) => c.trim().toUpperCase())
        .filter((code) => CODE_RE.test(code)),
    ),
  ].slice(0, 100);

  const normalizeCodeArray = (arr) =>
    Array.isArray(arr)
      ? [
          ...new Set(
            arr
              .filter((c) => typeof c === 'string')
              .map((c) => c.trim().toUpperCase())
              .filter((c) => CODE_RE.test(c)),
          ),
        ].slice(0, 100)
      : [];

  const scrub = (value) => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'has_dtc_fault') {
        out.has_dtc_fault = item === true || out.has_dtc_fault === true ? true : item;
        continue;
      }
      if (key === 'dtc_codes') {
        const normalized = normalizeCodeArray(item);
        out.dtc_codes = normalized;
        if (normalized.length > 0 || out.has_dtc_fault === true) {
          out.has_dtc_fault = true;
        }
        continue;
      }
      if (/^(?:dtc_ai|fault_codes|diagnostic_codes|scan_raw|scan_result)$/i.test(key)) continue;
      out[key] = scrub(item);
    }
    return out;
  };

  const sanitized = scrub(packet);
  if (sanitized.vehicle) {
    if (codes.length > 0) {
      sanitized.vehicle.dtc_codes = [
        ...new Set([...(sanitized.vehicle.dtc_codes || []), ...codes]),
      ].slice(0, 100);
      sanitized.vehicle.has_dtc_fault = true;
    } else if (!Array.isArray(sanitized.vehicle.dtc_codes)) {
      sanitized.vehicle.dtc_codes = [];
    }
  }

  let explanationsFailed = 0;
  if (api && codes.length > 0) {
    for (const code of codes.slice(0, 10)) {
      try {
        const explanation = await api.explain(code);
        await onExplanation?.(explanation);
      } catch {
        explanationsFailed++;
      }
    }
  }

  return { packet: sanitized, explanations_failed: explanationsFailed, codes_discarded: 0 };
}

export class CommandPoller {
  #config;
  #adapter;
  #api;
  #pollIntervalMs;
  #onConfiguration;
  #lastSettingsVersion;
  #timer = null;
  #busy = false;
  #seen = new Set();

  constructor(
    config,
    adapter,
    {
      pollIntervalMs = 5000,
      onConfiguration = null,
      initialSettingsVersion = null,
      api = null,
    } = {},
  ) {
    this.#config = config;
    this.#adapter = adapter;
    this.#api = api ?? createDeviceApi(config);
    this.#pollIntervalMs = pollIntervalMs;
    this.#onConfiguration = onConfiguration;
    this.#lastSettingsVersion =
      Number.isInteger(initialSettingsVersion) && initialSettingsVersion >= 1
        ? initialSettingsVersion
        : null;
  }

  get api() {
    return this.#api;
  }

  get lastSettingsVersion() {
    return this.#lastSettingsVersion;
  }

  async syncSettings() {
    const settingsPayload = await this.#api.settings();
    if (settingsPayload && typeof settingsPayload === 'object') {
      if (this.#onConfiguration) {
        await this.#onConfiguration(settingsPayload);
      } else if (this.#adapter?.applyConfiguration) {
        await this.#adapter.applyConfiguration(settingsPayload.settings ?? settingsPayload);
      }
      if (Number.isInteger(settingsPayload.version) && settingsPayload.version >= 1) {
        this.#lastSettingsVersion = settingsPayload.version;
      }
    }
    return settingsPayload;
  }

  start() {
    if (this.#timer) return;
    void this.pollOnce();
    this.#timer = setInterval(() => {
      void this.pollOnce();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  async pollOnce() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const batch = await this.#api.pending();
      if (
        batch?.settings_version !== undefined &&
        batch.settings_version !== null &&
        batch.settings_version !== this.#lastSettingsVersion
      ) {
        try {
          const settingsPayload = await this.syncSettings();
          if (
            !Number.isInteger(settingsPayload?.version) &&
            Number.isInteger(batch.settings_version)
          ) {
            this.#lastSettingsVersion = batch.settings_version;
          }
        } catch (error) {
          console.error(`[CMD] Settings auto-sync error: ${error.message}`);
        }
      }
      for (const item of (batch.items || []).slice(0, 10)) {
        let cmd;
        try {
          cmd = verifyCommand(item, this.#config);
        } catch {
          continue;
        }
        if (this.#seen.has(cmd.id)) continue;
        this.#seen.add(cmd.id);
        if (this.#seen.size > 1000) {
          this.#seen.delete(this.#seen.values().next().value);
        }
        console.log(`[CMD] Executing ${cmd.kind} command id=${cmd.id}`);
        const status = await executeCommand(cmd, this.#adapter, this.#api);
        console.log(`[CMD] Command id=${cmd.id} finished with status=${status}`);
      }
    } catch (error) {
      console.error(`[CMD] Poll error: ${error.message}`);
    } finally {
      this.#busy = false;
    }
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
