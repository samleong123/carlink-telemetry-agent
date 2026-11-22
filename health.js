import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round1 = (n) => Number(n.toFixed(1));

function readCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.irq +
      cpu.times.idle;
  }
  return { idle, total };
}

function readCpuTempC() {
  try {
    const raw = readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    const milliC = Number(raw);
    if (!Number.isFinite(milliC)) return null;
    const tempC = milliC > 500 ? milliC / 1000 : milliC;
    return clamp(round1(tempC), -40, 150);
  } catch {
    return null;
  }
}

function readMemoryUsagePct() {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo);
    const availMatch = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    if (totalMatch && availMatch) {
      const total = Number(totalMatch[1]);
      const avail = Number(availMatch[1]);
      if (total > 0) {
        return clamp(round1(((total - avail) / total) * 100), 0, 100);
      }
    }
  } catch {
    // Fallback below on non-Linux or missing procfs
  }
  const total = os.totalmem();
  const free = os.freemem();
  if (total <= 0) return null;
  return clamp(round1(((total - free) / total) * 100), 0, 100);
}

function readDiskUsagePct(targetPath = '/') {
  try {
    const stat = statfsSync(targetPath);
    if (stat.blocks > 0) {
      const used = stat.blocks - stat.bfree;
      return clamp(round1((used / stat.blocks) * 100), 0, 100);
    }
  } catch {
    // Ignore unsupported platform
  }
  return null;
}

export class DeviceHealthMonitor {
  #prevCpu = readCpuTimes();

  sample({ bleObdConnected = false, lteConnected = false, pendingRecords = 0, lastSyncAt = null } = {}) {
    const nowCpu = readCpuTimes();
    const totalDiff = nowCpu.total - this.#prevCpu.total;
    const idleDiff = nowCpu.idle - this.#prevCpu.idle;
    this.#prevCpu = nowCpu;

    const cpuUsagePct =
      totalDiff > 0 ? clamp(round1(((totalDiff - idleDiff) / totalDiff) * 100), 0, 100) : 0;

    return {
      cpu_temp_c: readCpuTempC(),
      cpu_usage_pct: cpuUsagePct,
      memory_usage_pct: readMemoryUsagePct(),
      disk_usage_pct: readDiskUsagePct('/'),
      uptime_s: clamp(Math.floor(os.uptime()), 0, 4294967295),
      ble_obd_connected: Boolean(bleObdConnected),
      lte_connected: Boolean(lteConnected),
      pending_records: clamp(Math.max(0, Math.floor(pendingRecords)), 0, 10000000),
      last_sync_at: lastSyncAt || null,
    };
  }
}
