/** Read-only, protocol-aware DTC scan for an ELM327. */
const TYPES = { '03': 'stored', '07': 'pending', '0A': 'permanent', '1802FF00': 'kwp', '1902FF': 'uds', '1003': 'session', '3E00': 'tester-present' };
const POSITIVE = { '03': 0x43, '07': 0x47, '0A': 0x4a, '13FF00': 0x53, '17FF00': 0x57, '1800FF00': 0x58, '1802FF00': 0x58, '18FF00': 0x58, '1003': 0x50, '3E': 0x7e, '3E00': 0x7e };
const UDS_STATUS_REQUESTS = new Set(['190208', '1902AC', '1902AF', '190223', '190278', '1902FF']);
for (const command of UDS_STATUS_REQUESTS) POSITIVE[command] = 0x59;
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

export function decodeDtc(a, b) {
  return `${'PCBU'[a >> 6]}${(a >> 4) & 3}${(a & 15).toString(16).toUpperCase()}${hex(b)}`;
}

function parsePayload(source, payload, protocol, command) {
  const result = { source, dtcs: [] };
  if (payload[0] === 0x7f) {
    result.error = `Negative response ${payload.map(hex).join(' ')}`;
    return result;
  }
  if (payload[0] !== POSITIVE[command]) {
    result.error = 'Unexpected response service';
    return result;
  }
  if (command === '3E') {
    if (payload.length !== 1) result.error = 'Unexpected tester-present response';
    return result;
  }
  if (command === '1003' || command === '3E00') {
    if (payload[1] !== (command === '1003' ? 3 : 0)) result.error = 'Unexpected session response';
    return result;
  }
  if (UDS_STATUS_REQUESTS.has(command)) {
    if (payload.length < 3 || payload[1] !== 2 || (payload.length - 3) % 4 !== 0) {
      result.error = 'Incomplete or unexpected UDS response';
      return result;
    }
    result.statusAvailability = payload[2];
    for (let i = 3; i < payload.length; i += 4) {
      result.dtcs.push({ code: decodeDtc(payload[i], payload[i + 1]), failureType: payload[i + 2], status: payload[i + 3] });
    }
    return result;
  }
  if (command === '1802FF00') {
    if (payload.length < 2 || payload.length !== 2 + payload[1] * 3) {
      result.error = 'Incomplete or unexpected KWP response';
      return result;
    }
    for (let i = 2; i < payload.length; i += 3) {
      result.dtcs.push({ code: decodeDtc(payload[i], payload[i + 1]), status: payload[i + 2] });
    }
    return result;
  }
  if (['1800FF00', '18FF00', '17FF00'].includes(command)) {
    result.error = 'Positive response has an unverified manufacturer-specific layout';
    return result;
  }
  if (command === '13FF00') {
    if (payload.length < 2 || payload.length !== 2 + payload[1] * 2) {
      result.error = 'Incomplete or unexpected service 13 response';
      return result;
    }
    for (let i = 2; i < payload.length; i += 2) {
      if (payload[i] === 0 && payload[i + 1] === 0) {
        result.dtcs = [];
        result.error = 'Unexpected empty DTC record';
        return result;
      }
      result.dtcs.push({ code: decodeDtc(payload[i], payload[i + 1]) });
    }
    return result;
  }
  let data = payload.slice(1);
  if ([6, 7, 8, 9].includes(Number(protocol))) {
    if (!data.length) { result.error = 'Missing DTC count'; return result; }
    const count = data[0];
    if (data.length < 1 + count * 2 || data.slice(1 + count * 2).some((b) => b !== 0)) {
      result.error = 'DTC count does not match response length'; return result;
    }
    data = data.slice(1, 1 + count * 2);
  } else {
    if (data.length % 2 === 0 && data[0] > 0 && 1 + data[0] * 2 <= data.length && data.slice(1 + data[0] * 2).every((b) => b === 0)) {
      result.error = 'Ambiguous K-line response: count and padding cannot be distinguished'; return result;
    }
    if (data.length % 2 === 1 && data[0] * 2 === data.length - 1) data = data.slice(1);
    if (data.length % 2) { result.error = 'Ambiguous or incomplete DTC bytes'; return result; }
  }
  for (let i = 0; i < data.length; i += 2) {
    if (data[i] || data[i + 1]) result.dtcs.push({ code: decodeDtc(data[i], data[i + 1]) });
  }
  return result;
}

export function parseDtcResponse(raw, protocolNumber, command) {
  const p = Number(protocolNumber);
  const results = [];
  const pending = new Map();
  const lines = String(raw).toUpperCase().replace(/>/g, '').split(/[\r\n]+/);
  for (let line of lines) {
    line = line.trim();
    if (!line || /^(SEARCHING|NO DATA|STOPPED|BUS|CAN ERROR|UNABLE|ERROR|OK|\?)/.test(line)) continue;
    if (line.replace(/\s/g, '') === command) continue;
    let source = null;
    let bytes;
    if ([6, 7, 8, 9].includes(p)) {
      const n = [7, 9].includes(p) ? 8 : 3;
      const spacedId = n === 8 && line.match(/^([0-9A-F]{2})\s+([0-9A-F]{2})\s+([0-9A-F]{2})\s+([0-9A-F]{2})\s+(.*)$/);
      const match = line.match(new RegExp(`^([0-9A-F]{${n}})\\s*(.*)$`));
      if (!match && !spacedId) {
        if (/^[0-9A-F]/.test(line)) results.push({ source: null, dtcs: [], error: 'Unrecognized CAN header formatting' });
        continue;
      }
      source = spacedId ? spacedId.slice(1, 5).join('') : match[1];
      const rest = (spacedId ? spacedId[5] : match[2]).replace(/\s+/g, '');
      if (!/^(?:[0-9A-F]{2})+$/.test(rest)) { results.push({ source, dtcs: [], error: 'Unrecognized CAN formatting' }); continue; }
      bytes = rest.match(/../g).map((x) => parseInt(x, 16));
      if (!bytes.length) continue;
      const pci = bytes[0];
      if ((pci & 0xf0) === 0x00) {
        const length = pci & 15;
        if (length === 0 || bytes.length < length + 1) { results.push({ source, dtcs: [], error: 'Incomplete CAN single frame' }); continue; }
        results.push(parsePayload(source, bytes.slice(1, length + 1), p, command));
      } else if ((pci & 0xf0) === 0x10) {
        if (bytes.length < 2) { results.push({ source, dtcs: [], error: 'Incomplete CAN first frame' }); continue; }
        const length = ((pci & 15) << 8) | bytes[1];
        pending.set(source, { length, bytes: bytes.slice(2), next: 1 });
      } else if ((pci & 0xf0) === 0x20) {
        const state = pending.get(source);
        if (!state || (pci & 15) !== state.next) { results.push({ source, dtcs: [], error: 'Missing or out-of-order CAN frame' }); pending.delete(source); continue; }
        state.bytes.push(...bytes.slice(1));
        state.next = (state.next + 1) & 15;
        if (state.bytes.length >= state.length) { results.push(parsePayload(source, state.bytes.slice(0, state.length), p, command)); pending.delete(source); }
      } else if (pci === POSITIVE[command] || pci === 0x7f) {
        results.push(parsePayload(source, bytes, p, command));
      } else results.push({ source, dtcs: [], error: 'Unrecognized CAN frame' });
    } else if ([3, 4, 5].includes(p)) {
      const s = line.replace(/\s+/g, '');
      if (!/^(?:[0-9A-F]{2}){5,}$/.test(s)) continue;
      bytes = s.match(/../g).map((x) => parseInt(x, 16));
      source = hex(bytes[2]);
      const checksum = bytes.slice(0, -1).reduce((a, b) => a + b, 0) & 255;
      if (checksum !== bytes.at(-1)) { results.push({ source, dtcs: [], error: 'Missing or invalid K-line checksum' }); continue; }
      if (p === 3) {
        if (bytes[0] !== 0x48 || bytes[1] !== 0x6b) { results.push({ source, dtcs: [], error: 'Unrecognized ISO 9141 header' }); continue; }
        results.push(parsePayload(source, bytes.slice(3, -1), p, command));
      } else {
        let start = 3;
        let length = bytes[0] & 0x3f;
        if ((bytes[0] & 0xc0) !== 0x80) { results.push({ source, dtcs: [], error: 'Unrecognized KWP header' }); continue; }
        if (!length) { length = bytes[3]; start++; }
        if (start + length !== bytes.length - 1) { results.push({ source, dtcs: [], error: 'Incomplete KWP frame' }); continue; }
        results.push(parsePayload(source, bytes.slice(start, start + length), p, command));
      }
    }
  }
  for (const [source] of pending) results.push({ source, dtcs: [], error: 'Incomplete CAN multi-frame response' });
  return results;
}

function detectedProtocol(raw) {
  for (const line of String(raw).toUpperCase().split(/[\r\n>]+/)) {
    const match = line.trim().match(/^A?([0-9])$/);
    if (match) return match[1];
  }
  return null;
}

export async function scanDtcs(elm, send, options = {}) {
  const report = { protocol: { number: null, description: '' }, attempts: [], warnings: [] };
  let transportFailed = false;
  async function request(cmd, timeout = 8000) {
    try { return await send(elm, cmd, timeout); }
    catch (error) { transportFailed = true; throw error; }
  }
  async function configure(cmd) {
    const raw = await request(cmd);
    if (!/(?:^|[\r\n])\s*OK\s*(?:[\r\n>]|$)/i.test(raw)) throw new Error(`Adapter rejected ${cmd}: ${String(raw).trim()}`);
  }
  async function scan(target, command) {
    const raw = await request(command);
    const responses = parseDtcResponse(raw, report.protocol.number, command);
    const status = responses.some((r) => !r.error) ? 'decoded' : responses.length ? 'unparsed' : 'no-response';
    const attempt = { target, kind: TYPES[command], command, raw, responses, status };
    report.attempts.push(attempt);
    return attempt;
  }
  try {
    for (const cmd of ['ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATAL', 'ATSP0']) await configure(cmd);
    const probe = await request('0100', 15000);
    const numberRaw = await request('ATDPN');
    report.protocol.number = detectedProtocol(numberRaw);
    report.protocol.description = String(await request('ATDP')).replace(/[\r\n>]+/g, ' ').trim();
    if (!/41\s*00/i.test(probe) || ![3, 4, 5, 6, 7, 8, 9].includes(Number(report.protocol.number))) {
      report.warnings.push('Automatic detection did not establish a supported ISO 9141, KWP or CAN OBD connection; no physical scan was attempted.');
      return report;
    }
    const p = Number(report.protocol.number);
    if ([7, 9].includes(p)) await configure('ATCP18');
    const header = async (target, command) => {
      let h;
      if (p === 3) h = `68${target}F1`;
      else if (p === 4 || p === 5) h = `${target === '33' ? 'C' : '8'}${(command.length / 2).toString(16).toUpperCase()}${target}F1`;
      else if (p === 6 || p === 8) h = target;
      else h = target === 'functional' ? 'DB33F1' : `DA${target}F1`;
      await configure(`ATSH${h}`);
    };
    const functional = p === 3 ? '6A' : p === 4 || p === 5 ? '33' : p === 6 || p === 8 ? '7DF' : 'functional';
    for (const cmd of ['03', '07', '0A']) { await header(functional, cmd); await scan('functional', cmd); }
    const targets = p === 3 || p === 4 || p === 5 ? ['10', '18', '20', '28'] : p === 6 || p === 8 ? ['7E0', '7E1', '7E2', '7E3', '7E4', '7E5', '7E6', '7E7'] : ['00', '01', '02', '03', '04', '05', '06', '07'];
    for (const target of targets) {
      for (const cmd of ['03', '07', '0A', ...(p === 3 || p === 4 || p === 5 ? ['1802FF00'] : ['1802FF00', '1902FF'])]) {
        await header(target, cmd);
        await scan(target, cmd);
      }
      if (options.extended) {
        await header(target, '1003');
        const session = await scan(target, '1003');
        if (session.responses.some((response) => !response.error)) {
          await header(target, '3E00');
          await scan(target, '3E00');
          for (const cmd of p === 3 || p === 4 || p === 5 ? ['1802FF00'] : ['1802FF00', '1902FF']) {
            await header(target, cmd);
            await scan(target, cmd);
          }
        }
      }
    }
    if (options.extended) report.warnings.push('Extended session requests may temporarily change ECU diagnostic state; the ECU controls session expiry.');
    report.warnings.push('Physical addresses are candidates, not verified module identities. NO DATA does not prove that a module is absent or has no faults.');
    report.warnings.push('Manufacturer profiles, gateway access, sessions and adapter formatting can limit coverage. Preserve raw responses and verify uncertain results.');
    return report;
  } finally {
    if (!transportFailed) {
      for (const cmd of ['ATD', 'ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATSP0']) await configure(cmd);
    }
  }
}
