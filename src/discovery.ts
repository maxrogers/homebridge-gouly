/**
 * Find a controller on the LAN without knowing its IP.
 *
 * Gouly controllers do not broadcast (no Tuya UDP discovery), so:
 *   1. list the /24 networks this machine is on,
 *   2. find hosts accepting TCP on 6668 (the Tuya local port),
 *   3. try the device id + local key against each; only the right controller
 *      completes the encrypted handshake and answers a query.
 * Step 2 is a few hundred short connection attempts, run only at setup or when
 * the controller stops answering at its known address.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';

import { GoulyConnection } from './connection';
import { ClassicDriver } from './protocol/classic';
import { ProDriver } from './protocol/pro';

export const TUYA_PORT = 6668;

export function localSubnetHosts(): string[] {
  const hosts = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const prefix = a.address.split('.').slice(0, 3).join('.');
      if (prefix.startsWith('169.254')) continue;
      for (let i = 1; i < 255; i++) {
        const ip = `${prefix}.${i}`;
        if (ip !== a.address) hosts.add(ip);
      }
    }
  }
  return [...hosts];
}

export function isPortOpen(host: string, port = TUYA_PORT, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function scanForTuyaHosts(hosts = localSubnetHosts(), concurrency = 64, port = TUYA_PORT): Promise<string[]> {
  const open: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      if (await isPortOpen(host, port)) open.push(host);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return open.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
}

/**
 * True when the controller at host completes the encrypted handshake with this id
 * and key. Uses the same Python bridge as normal operation.
 */
export function confirmController(
  host: string, id: string, key: string, version = '3.4', timeoutMs = 8000, pythonPath?: string,
): Promise<boolean> {
  return new Promise(resolve => {
    const quiet = { debug() { /* discovery is quiet */ }, info() { /* */ }, warn() { /* */ } };
    const conn = new GoulyConnection({ id, key, host, version, pythonPath, log: quiet });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.stop();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    conn.on('connected', () => finish(true));
    conn.on('unreachable', () => finish(false));
    conn.start();
  });
}

// ---------------------------------------------------------------- guided search

/**
 * MAC address prefixes seen on Gouly controllers. A match is a hint, not proof:
 * the same Wi-Fi modules are used in other Tuya products.
 */
const KNOWN_MAC_PREFIXES: Record<string, string> = {
  'c4:82:e1': 'seen on GOULY single-output controllers',
};

/** IP to MAC from the system's ARP cache (Linux /proc/net/arp, else `arp -an`). Best effort. */
export async function readArpTable(): Promise<Map<string, string>> {
  const table = new Map<string, string>();
  try {
    const text = await fs.readFile('/proc/net/arp', 'utf8');
    for (const line of text.split('\n').slice(1)) {
      const [ip, , , mac] = line.trim().split(/\s+/);
      if (ip && mac && mac !== '00:00:00:00:00:00') table.set(ip, mac.toLowerCase());
    }
    return table;
  } catch {
    // not Linux
  }
  const out = await new Promise<string>(resolve =>
    execFile('arp', ['-an'], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout)));
  for (const m of out.matchAll(/\(([\d.]+)\) at ([0-9a-f:]+)/gi)) {
    const mac = m[2].split(':').map(p => p.padStart(2, '0')).join(':').toLowerCase();
    table.set(m[1], mac);
  }
  return table;
}

export interface Candidate {
  ip: string;
  mac?: string;
  macNote?: string;
  confirmed?: boolean;
  type?: 'classic' | 'pro';
  protocol?: string;
}

/**
 * Connect with the id and key, then ask both controller families for a state
 * report; the one that answers identifies the type.
 */
export function identifyController(
  host: string, id: string, key: string, version = '3.4', pythonPath?: string, timeoutMs = 10000,
): Promise<Candidate> {
  return new Promise(resolve => {
    const quiet = { debug() { /* quiet */ }, info() { /* quiet */ }, warn() { /* quiet */ } };
    const conn = new GoulyConnection({ id, key, host, version, pythonPath, log: quiet });
    const result: Candidate = { ip: host, confirmed: false };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.stop();
      resolve(result);
    };
    const timer = setTimeout(finish, timeoutMs);
    conn.on('connected', ({ protocol }) => {
      result.confirmed = true;
      result.protocol = protocol;
      conn.send([...new ClassicDriver(false).query(), ...new ProDriver().query()]);
      setTimeout(finish, 2500);
    });
    conn.on('frame', f => {
      if (f[0] !== 0xbb) return;
      if (f[1] === 0xfc) result.type = 'classic';
      else if (f[1] === 0xb6) result.type = 'pro';
      if (result.type) finish();
    });
    conn.on('unreachable', finish);
    conn.start();
  });
}

/**
 * Search the local network and explain each step. Without an id and key it can
 * only list devices answering on the Tuya port; with them it confirms which one
 * is this controller and identifies its type.
 */
export async function guidedSearch(opts: {
  id?: string; key?: string; version?: string; hint?: string; pythonPath?: string;
  onLine: (line: string) => void;
  /** Tests supply their own scan; normally the local /24 networks are scanned. */
  scan?: () => Promise<string[]>;
}): Promise<{ host?: string; candidates: Candidate[] }> {
  const say = opts.onLine;
  const subnets = [...new Set(localSubnetHosts().map(h => h.split('.').slice(0, 3).join('.') + '.0/24'))];
  say(`Scanning ${subnets.join(', ') || 'no network interfaces found'} for port ${TUYA_PORT} (Tuya devices)...`);
  const open = await (opts.scan ?? scanForTuyaHosts)();
  const arp = await readArpTable();
  const candidates: Candidate[] = open.map(ip => {
    const mac = arp.get(ip);
    const note = mac ? KNOWN_MAC_PREFIXES[mac.slice(0, 8)] : undefined;
    return { ip, mac, macNote: note };
  });
  if (!candidates.length) {
    say('No devices answered on the Tuya port. Check the controller is powered and on the same network as Homebridge.');
    return { candidates };
  }
  for (const c of candidates) {
    say(`Found a Tuya device at ${c.ip}${c.mac ? `, MAC ${c.mac}` : ''}${c.macNote ? ` (MAC prefix ${c.macNote})` : ''}.`);
  }
  if (!opts.id || !opts.key) {
    say('Enter the Device ID and Local Key, then search again to confirm which one is this controller.');
    return { candidates };
  }
  // Most likely first: the previous address, then known MAC prefixes.
  const order = [...candidates].sort((a, b) =>
    Number(b.ip === opts.hint) - Number(a.ip === opts.hint) || Number(!!b.macNote) - Number(!!a.macNote));
  for (const c of order) {
    say(`Trying the Device ID and Local Key at ${c.ip}...`);
    Object.assign(c, await identifyController(c.ip, opts.id, opts.key, opts.version, opts.pythonPath));
    if (c.confirmed) {
      const type = c.type === 'pro' ? 'a Gouly Pro (answered the Pro state query)'
        : c.type === 'classic' ? 'a GOULY single-output controller (answered the classic state query)'
          : 'a controller that did not answer either state query';
      say(`Confirmed: ${c.ip} accepted the key using Tuya protocol ${c.protocol}. It is ${type}.`);
      return { host: c.ip, candidates };
    }
    say(`${c.ip} did not accept this Device ID and Local Key (another device, or a different key).`);
  }
  say('No device accepted this Device ID and Local Key. If the controller was reset or re-paired in the Gouly app, its key changed.');
  return { candidates };
}
