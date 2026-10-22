/**
 * Find a controller on the LAN, with or without its Device ID and Local Key.
 *
 * Gouly controllers answer slowly, and their Tuya UDP announcements (which carry
 * the Device ID) are occasional, so they cannot be relied on alone. The approach follows ha-gouly's gouly-keys (patient TCP scan) and
 * tinytuya's scanner (protocol fingerprinting), plus the cheap extras:
 *   1. List this machine's real LAN interfaces (Docker, VPN and other virtual
 *      interfaces are skipped) and their /24 networks.
 *   2. Check the saved IP and ARP-known Tuya MAC addresses first, then sweep the
 *      networks for TCP port 6668 (the Tuya local port) with a generous timeout.
 *      Hosts that exist (in the ARP table) but timed out are retried with a
 *      longer one.
 *   3. Probe each open port (python/gouly_probe.py): without a key, a keyless
 *      fingerprint says whether it behaves like a Tuya device; with a key, a
 *      signed handshake says whether it holds that key. Meanwhile, listen for
 *      Tuya UDP announcements; a controller announcing this Device ID is
 *      identified even when its TCP port is not answering.
 *   4. Label each device by its MAC vendor (Tuya's registered prefixes) and
 *      reverse DNS name, then rank them and explain each in a plain sentence.
 * A missing or wrong key never hides a device: it is listed as probable, with a
 * note saying what to do.
 */
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { promises as dns } from 'dns';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { GoulyConnection } from './connection';
import { ClassicDriver } from './protocol/classic';
import { ProDriver } from './protocol/pro';

export const TUYA_PORT = 6668;
/** Gouly controllers can take over a second to accept a connection (ha-gouly uses 3 s). */
export const SCAN_TIMEOUT_MS = 3000;
export const SCAN_CONCURRENCY = 32;
const RETRY_TIMEOUT_MS = 6000;
export const PROBE_SCRIPT = path.join(__dirname, '..', 'python', 'gouly_probe.py');

// ---------------------------------------------------------------- networks

/** Docker, VPN, VM and other virtual interfaces: a controller is never behind these. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|weave|kube|lxc|lxdbr|podman|tailscale|zt|wg|utun|tun|tap|ipsec|ppp|awdl|llw|anpi|gif|stf|bridge\d)/i;

/** Tailscale and carrier-grade NAT addresses (100.64.0.0/10). */
function isCgnat(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export interface LanInterface { name: string; address: string; network: string }

/** This machine's LAN IPv4 interfaces, virtual ones skipped. */
export function lanInterfaces(interfaces = os.networkInterfaces()): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254') || isCgnat(a.address)) continue;
      out.push({ name, address: a.address, network: a.address.split('.').slice(0, 3).join('.') + '.0/24' });
    }
  }
  return out;
}

/** Every other address on the /24 of each LAN interface. */
export function localSubnetHosts(interfaces = lanInterfaces()): string[] {
  const own = new Set(interfaces.map(i => i.address));
  const hosts = new Set<string>();
  for (const i of interfaces) {
    const prefix = i.address.split('.').slice(0, 3).join('.');
    for (let n = 1; n < 255; n++) {
      const ip = `${prefix}.${n}`;
      if (!own.has(ip)) hosts.add(ip);
    }
  }
  return [...hosts];
}

export type PortState = 'open' | 'closed' | 'timeout';

export function checkPort(host: string, port = TUYA_PORT, timeoutMs = SCAN_TIMEOUT_MS): Promise<PortState> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (state: PortState) => {
      socket.removeAllListeners();
      socket.on('error', () => { /* late errors after destroy */ });
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('open'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'ETIMEDOUT' ? 'timeout' : 'closed'));
  });
}

export async function isPortOpen(host: string, port = TUYA_PORT, timeoutMs = SCAN_TIMEOUT_MS): Promise<boolean> {
  return (await checkPort(host, port, timeoutMs)) === 'open';
}

/** Check many hosts, a few dozen at a time. Calls onOpen as each open port is found. */
export async function sweep(
  hosts: string[], opts: { port?: number; timeoutMs?: number; concurrency?: number; onOpen?: (ip: string) => void } = {},
): Promise<Map<string, PortState>> {
  const states = new Map<string, PortState>();
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      const state = await checkPort(host, opts.port ?? TUYA_PORT, opts.timeoutMs ?? SCAN_TIMEOUT_MS);
      states.set(host, state);
      if (state === 'open') opts.onOpen?.(host);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? SCAN_CONCURRENCY, hosts.length) }, worker));
  return states;
}

export async function scanForTuyaHosts(hosts = localSubnetHosts(), concurrency = SCAN_CONCURRENCY, port = TUYA_PORT): Promise<string[]> {
  const states = await sweep(hosts, { concurrency, port });
  return [...states].filter(([, s]) => s === 'open').map(([ip]) => ip).sort(byIp);
}

const byIp = (a: string, b: string) => {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

// ---------------------------------------------------------------- MAC addresses

/**
 * MAC prefixes registered to Tuya Smart Inc. (IEEE OUI list). Gouly controllers
 * use Tuya Wi-Fi modules, so a match means "a Tuya device", not proof of Gouly.
 */
export const TUYA_OUIS = new Set([
  '00:33:7a', '10:5a:17', '10:d5:61', '18:69:d8', '18:de:50', '1c:90:ff', '20:f1:b2', '2c:b4:71', '30:48:7d',
  '38:1f:8d', '38:2c:e5', '38:a5:c9', '3c:0b:59', '4c:a9:19', '50:8a:06', '50:8b:b9', '68:57:2d', '70:89:76',
  '7c:f6:66', '80:64:7c', '84:e3:42', 'a0:92:08', 'a8:80:55', 'a8:dd:bc', 'ac:f8:78', 'b8:06:0d', 'bc:35:1e',
  'c0:f8:53', 'c4:82:e1', 'cc:8c:bf', 'd0:32:e7', 'd0:82:e8', 'd0:82:eb', 'd4:a6:51', 'd8:1f:12', 'd8:c8:0c',
  'd8:d6:68', 'd8:fc:92', 'e4:ae:e4', 'f8:17:2d', 'fc:3c:d7', 'fc:67:1f',
]);

/** Locally administered MAC (the second bit of the first byte), as phones and computers use for privacy. */
export function isRandomMac(mac?: string): boolean {
  return !!mac && (parseInt(mac.slice(0, 2), 16) & 0x02) === 0x02;
}

export function macVendor(mac?: string): string | undefined {
  return mac && TUYA_OUIS.has(mac.slice(0, 8).toLowerCase()) ? 'Tuya' : undefined;
}

/** IP to MAC from the system's ARP cache (Linux /proc/net/arp, else `arp -an`). Best effort. */
export async function readArpTable(): Promise<Map<string, string>> {
  const table = new Map<string, string>();
  try {
    const text = await fs.readFile('/proc/net/arp', 'utf8');
    for (const line of text.split('\n').slice(1)) {
      const [ip, , flags, mac, , dev] = line.trim().split(/\s+/);
      if (!ip || !mac || mac === '00:00:00:00:00:00' || flags === '0x0') continue;
      if (dev && VIRTUAL_INTERFACE.test(dev)) continue;
      table.set(ip, mac.toLowerCase());
    }
    return table;
  } catch {
    // not Linux
  }
  const out = await new Promise<string>(resolve =>
    execFile('arp', ['-an'], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout)));
  for (const m of out.matchAll(/\(([\d.]+)\) at ([0-9a-f:]+)(?: on (\S+))?/gi)) {
    if (m[3] && VIRTUAL_INTERFACE.test(m[3])) continue;
    const mac = m[2].split(':').map(p => p.padStart(2, '0')).join(':').toLowerCase();
    if (mac.split(':').length === 6) table.set(m[1], mac);
  }
  return table;
}

async function reverseName(ip: string, timeoutMs = 1500): Promise<string | undefined> {
  const lookup = dns.reverse(ip).then(names => names[0]?.replace(/\.$/, ''), () => undefined);
  const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs).unref());
  return Promise.race([lookup, timeout]);
}

// ---------------------------------------------------------------- probing

export interface ProbeResult {
  ip: string;
  port?: 'open' | 'closed' | 'timeout' | 'unreachable';
  tuya?: 'yes' | 'likely' | 'no';
  protocol?: string | null;
  key?: 'ok' | 'wrong' | 'none';
  answer?: string;
  keyAnswer?: string;
  ms?: number;
}

export interface Announcement { ip: string; id?: string; version?: string; productKey?: string }

/** Probe hosts as they are found (python/gouly_probe.py), and collect UDP announcements meanwhile. */
export interface ProbeSession {
  add(ip: string): void;
  /** The result for one host, once its probe is done (undefined if the helper is not running). */
  wait(ip: string): Promise<ProbeResult | undefined>;
  /** No more hosts: wait for the probes in flight. */
  finish(): Promise<{ results: Map<string, ProbeResult>; announcements: Announcement[]; available: boolean }>;
}

export function startProbe(opts: {
  id?: string; key?: string; pythonPath?: string; port?: number; timeoutSec?: number; listenSec?: number;
  onResult?: (r: ProbeResult) => void; onNote?: (text: string) => void;
}): ProbeSession {
  const results = new Map<string, ProbeResult>();
  const announcements: Announcement[] = [];
  const waiters = new Map<string, Array<(r?: ProbeResult) => void>>();
  let available = true;
  let ended = false;
  let proc: ChildProcessWithoutNullStreams | undefined;
  const config = JSON.stringify({ id: opts.id || undefined, key: opts.key || undefined, listen: opts.listenSec ?? 120,
    timeout: opts.timeoutSec ?? 5, port: opts.port ?? TUYA_PORT });
  const exited = new Promise<void>(resolve => {
    try {
      // The key goes through the environment, not argv, so it stays out of process listings.
      proc = spawn(opts.pythonPath || 'python3', ['-u', PROBE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GOULY_PROBE_CONFIG: config },
      });
    } catch {
      available = false;
      resolve();
      return;
    }
    const end = () => {
      ended = true;
      for (const list of waiters.values()) for (const w of list) w(undefined);
      waiters.clear();
      resolve();
    };
    proc.on('error', () => { available = false; end(); });
    proc.on('exit', end);
    proc.stdin.on('error', () => { /* exited early */ });
    proc.stderr.resume();
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.event === 'probe') {
        const r: ProbeResult = { ...msg };
        delete (r as { event?: string }).event;
        results.set(r.ip, r);
        opts.onResult?.(r);
        for (const w of waiters.get(r.ip) ?? []) w(r);
        waiters.delete(r.ip);
      } else if (msg.event === 'udp') {
        announcements.push({ ip: msg.ip, id: msg.id ?? undefined, version: msg.version ?? undefined, productKey: msg.productKey ?? undefined });
      } else if (msg.event === 'note') {
        opts.onNote?.(String(msg.text));
      }
    });
  });
  return {
    add(ip) {
      if (proc && proc.exitCode === null && proc.stdin.writable) proc.stdin.write(ip + '\n');
    },
    wait(ip) {
      if (results.has(ip)) return Promise.resolve(results.get(ip));
      if (ended || !proc) return Promise.resolve(undefined);
      return new Promise(resolve => waiters.set(ip, [...(waiters.get(ip) ?? []), resolve]));
    },
    async finish() {
      proc?.stdin.end();
      const guard = setTimeout(() => proc?.kill(), 60_000);
      await exited;
      clearTimeout(guard);
      if (proc && proc.exitCode !== 0 && results.size === 0) available = false;
      return { results, announcements, available };
    },
  };
}

// ---------------------------------------------------------------- key check and type

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
    conn.on('rejected', () => finish(false));
    conn.start();
  });
}

/**
 * Connect with the id and key, then ask both controller families for a state
 * report; the one that answers identifies the type.
 */
export function identifyController(
  host: string, id: string, key: string, version = '3.4', pythonPath?: string, timeoutMs = 12000,
): Promise<{ confirmed: boolean; protocol?: string; type?: 'classic' | 'pro'; rejected?: boolean }> {
  return new Promise(resolve => {
    const quiet = { debug() { /* quiet */ }, info() { /* quiet */ }, warn() { /* quiet */ } };
    const conn = new GoulyConnection({ id, key, host, version, pythonPath, log: quiet });
    const result: { confirmed: boolean; protocol?: string; type?: 'classic' | 'pro'; rejected?: boolean } = { confirmed: false };
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
    conn.on('rejected', () => { result.rejected = true; finish(); });
    conn.start();
  });
}

// ---------------------------------------------------------------- guided search

export type CandidateStatus = 'confirmed' | 'connected' | 'wrong-key' | 'probable' | 'possible' | 'other';

export interface Candidate {
  ip: string;
  /** Plain-language summary for the settings page. */
  status: CandidateStatus;
  note: string;
  mac?: string;
  vendor?: string;
  name?: string;
  saved?: boolean;
  tuya?: 'yes' | 'likely' | 'no';
  key?: 'ok' | 'wrong' | 'none';
  /** What the probe saw, for the search log. */
  answer?: string;
  announcedId?: string;
  confirmed?: boolean;
  type?: 'classic' | 'pro';
  protocol?: string;
}

const STATUS_ORDER: CandidateStatus[] = ['confirmed', 'connected', 'wrong-key', 'probable', 'possible', 'other'];

/** Rank and explain one device. Exported for tests. */
export function describe(c: Omit<Candidate, 'status' | 'note'>, opts: { id?: string; key?: string }): Candidate {
  // A randomized ("private") MAC belongs to a phone or computer, never to a Tuya
  // module, so a closed connection alone ("likely") does not make it Tuya-like.
  const likely = c.tuya === 'likely' && !isRandomMac(c.mac);
  const tuyaLike = c.tuya === 'yes' || likely || c.vendor === 'Tuya' || !!c.announcedId;
  const typeName = c.type === 'pro' ? 'Gouly Pro' : c.type === 'classic' ? 'GOULY single-output controller' : '';
  let status: CandidateStatus;
  let note: string;
  if (c.confirmed || c.key === 'ok') {
    status = 'confirmed';
    note = `Your controller${typeName ? ` (${typeName})` : ''}. The Local Key works here.`;
  } else if (c.announcedId && opts.id && c.announcedId !== opts.id) {
    status = 'other';
    note = `A Tuya device with a different Device ID (${c.announcedId}).`;
  } else if (c.announcedId && opts.id && c.announcedId === opts.id) {
    status = c.key === 'wrong' ? 'wrong-key' : 'probable';
    note = c.key === 'wrong' ? 'This is your controller (it announced this Device ID), but it refused the connection. '
        + 'If the plugin worked with this key recently, unplug the controller for 10 seconds; otherwise get the keys again.'
      : opts.key ? 'This is your controller (it announced this Device ID), but it is not accepting connections right now. '
        + 'It may be busy or have a weak Wi-Fi signal; try again in a few minutes.'
        : 'This is your controller (it announced this Device ID). Add the Local Key to connect.';
  } else if (c.key === 'wrong' && tuyaLike) {
    status = 'wrong-key';
    note = 'A Tuya device that did not accept this Local Key. If this is your controller and the plugin worked with this key '
      + 'recently, unplug it for 10 seconds; otherwise its key has changed: get the keys again.';
  } else if (tuyaLike) {
    status = 'probable';
    note = 'Probably a Tuya device, like a Gouly controller. Add the Device ID and Local Key to confirm it is yours.';
  } else if (c.key === 'wrong') {
    status = 'possible';
    note = 'Something answers on the Tuya port, but it did not accept this Local Key and does not look like a Tuya device.';
  } else {
    status = 'possible';
    note = opts.key ? 'Something answers on the Tuya port, but it does not look like a Tuya device.'
      : 'Something answers on the Tuya port. Add the Device ID and Local Key to check it.';
  }
  return { ...c, status, note };
}

function rank(list: Candidate[]): Candidate[] {
  const score = (c: Candidate) => STATUS_ORDER.indexOf(c.status) * 10
    - (c.saved ? 4 : 0) - (c.vendor === 'Tuya' ? 2 : 0) - (c.tuya === 'yes' || c.tuya === 'likely' ? 1 : 0);
  return [...list].sort((a, b) => score(a) - score(b) || byIp(a.ip, b.ip));
}

export interface SearchOptions {
  id?: string; key?: string; version?: string; pythonPath?: string;
  /** The saved IP address: checked first. */
  hint?: string;
  /** The plugin is connected to this controller at this address right now: it is not probed again. */
  connectedHost?: string;
  /** Stop as soon as the controller is confirmed (the plugin's automatic search). */
  stopWhenConfirmed?: boolean;
  onLine: (line: string) => void;
  /** Tests: the hosts to check, the port, and short timeouts. */
  hosts?: string[]; port?: number; scanTimeoutMs?: number; probeTimeoutSec?: number;
}

export interface SearchResult { host?: string; candidates: Candidate[] }

/**
 * Search the local network and explain each step. Every device answering on the
 * Tuya port is listed, ranked and explained, whether or not keys are given.
 */
export async function guidedSearch(opts: SearchOptions): Promise<SearchResult> {
  const say = opts.onLine;
  const id = opts.id?.trim() || undefined;
  const key = opts.key || undefined;
  const port = opts.port ?? TUYA_PORT;
  const ifaces = lanInterfaces();
  const networks = [...new Set(ifaces.map(i => i.network))];
  const hosts = opts.hosts ?? localSubnetHosts(ifaces);
  if (!opts.hosts) {
    say(networks.length ? `Searching ${networks.join(', ')} for Tuya devices. This takes about 30 seconds.`
      : 'No network interfaces found to search.');
  }
  if (key && key.length !== 16) say('The Local Key should be 16 characters; check it was copied completely.');

  const found = new Map<string, Omit<Candidate, 'status' | 'note'>>();
  const probe = startProbe({ id, key, pythonPath: opts.pythonPath, port, timeoutSec: opts.probeTimeoutSec,
    onNote: text => say(`(${text})`) });
  const onOpen = (ip: string) => {
    if (found.has(ip)) return;
    found.set(ip, { ip, saved: ip === opts.hint });
    say(`${ip} answers on the Tuya port; checking it...`);
    probe.add(ip);
  };

  // The plugin's own connection: already confirmed, and a second connection could disturb it.
  if (opts.connectedHost) {
    found.set(opts.connectedHost, { ip: opts.connectedHost, saved: opts.connectedHost === opts.hint, tuya: 'yes', key: 'ok' });
  }

  // 1. The saved address and ARP-known Tuya devices, patiently.
  let arp = await readArpTable();
  const first = [...new Set([opts.hint, ...[...arp].filter(([, mac]) => macVendor(mac)).map(([ip]) => ip)])]
    .filter((ip): ip is string => !!ip && ip !== opts.connectedHost && (!opts.hosts || opts.hosts.includes(ip)));
  if (opts.hint && opts.hint !== opts.connectedHost) say(`Checking the saved IP ${opts.hint} first.`);
  const firstStates = await sweep(first, { port, timeoutMs: RETRY_TIMEOUT_MS, onOpen });
  if (opts.hint && firstStates.get(opts.hint) && firstStates.get(opts.hint) !== 'open') {
    say(`Nothing answers on the Tuya port at ${opts.hint}.`);
  }

  // 2. Everything else on the network; hosts that exist but were slow get a second, longer try.
  const rest = hosts.filter(ip => !firstStates.has(ip) && ip !== opts.connectedHost);
  if (opts.stopWhenConfirmed && key) {
    const opened = first.filter(ip => firstStates.get(ip) === 'open');
    const results = await Promise.all(opened.map(ip => probe.wait(ip)));
    if (results.some(r => r?.key === 'ok')) return finishSearch(opts, found, await probe.finish(), arp, say);
  }
  const states = await sweep(rest, { port, timeoutMs: opts.scanTimeoutMs ?? SCAN_TIMEOUT_MS, onOpen });
  arp = await readArpTable();
  const slow = [...states].filter(([ip, s]) => s === 'timeout' && arp.has(ip)).map(([ip]) => ip);
  if (slow.length) await sweep(slow, { port, timeoutMs: RETRY_TIMEOUT_MS, onOpen });

  const probed = await probe.finish();
  return finishSearch(opts, found, probed, arp, say);
}

function describeAll(
  found: Map<string, Omit<Candidate, 'status' | 'note'>>, probed: { results: Map<string, ProbeResult>; announcements: Announcement[] },
  arp: Map<string, string>, keys: { id?: string; key?: string },
): Candidate[] {
  for (const a of probed.announcements) {
    const c = found.get(a.ip) ?? { ip: a.ip };
    found.set(a.ip, { ...c, announcedId: a.id, tuya: c.tuya ?? 'yes', protocol: c.protocol ?? a.version });
  }
  return [...found.values()].map(c => {
    const r = probed.results.get(c.ip);
    const mac = c.mac ?? arp.get(c.ip);
    return describe({ ...c, mac, vendor: macVendor(mac), tuya: c.tuya ?? r?.tuya, key: c.key ?? r?.key,
      answer: [r?.keyAnswer, r?.answer].filter(Boolean).join('; ') || undefined, protocol: c.protocol ?? r?.protocol ?? undefined }, keys);
  });
}

async function finishSearch(
  opts: SearchOptions, found: Map<string, Omit<Candidate, 'status' | 'note'>>,
  probed: { results: Map<string, ProbeResult>; announcements: Announcement[]; available: boolean },
  arp: Map<string, string>, say: (l: string) => void,
): Promise<SearchResult> {
  const id = opts.id?.trim() || undefined;
  const key = opts.key || undefined;
  if (!probed.available && found.size) say('Could not run the Python helper to check devices; showing what the port scan found.');
  let candidates = describeAll(found, probed, arp, { id, key });
  await Promise.all(candidates.map(async c => { c.name = await reverseName(c.ip); }));

  // Identify the confirmed controller's type. If no device passed the quick key
  // check, give the most likely ones the full connection test as well.
  if (id && key) {
    const confirmed = candidates.filter(c => c.status === 'confirmed' && c.ip !== opts.connectedHost);
    const fallback = confirmed.length || !probed.available ? []
      : rank(candidates.filter(c => c.status === 'wrong-key' || c.status === 'probable')).slice(0, 3);
    for (const c of [...confirmed, ...fallback]) {
      const r = await identifyController(c.ip, id, key, opts.version, opts.pythonPath);
      if (r.confirmed) Object.assign(c, { confirmed: true, protocol: r.protocol, type: r.type });
      else if (r.rejected) c.key = 'wrong';
    }
    if (!probed.available) {
      for (const c of rank(candidates).slice(0, 5)) {
        if (c.confirmed) continue;
        const r = await identifyController(c.ip, id, key, opts.version, opts.pythonPath);
        if (r.confirmed) Object.assign(c, { confirmed: true, protocol: r.protocol, type: r.type });
        else if (r.rejected) c.key = 'wrong';
      }
    }
    candidates = candidates.map(c => describe(c, { id, key }));
  }
  if (opts.connectedHost) {
    const c = candidates.find(x => x.ip === opts.connectedHost);
    if (c) Object.assign(c, { status: 'connected', note: 'Your controller. The plugin is connected to it right now.' });
  }
  const host = rank(candidates).find(c => c.status === 'confirmed' || c.status === 'connected')?.ip;
  if (host) {
    // The controller is found, so the other Tuya devices are simply other devices.
    for (const c of candidates) {
      if (c.status === 'wrong-key' || c.status === 'probable') Object.assign(c, { status: 'other', note: 'Another Tuya device.' });
    }
  }
  candidates = rank(candidates);

  for (const c of candidates) {
    const label = [c.mac && `MAC ${c.mac}${c.vendor ? ` (${c.vendor})` : ''}`, c.name].filter(Boolean).join(', ');
    say(`${c.ip}${label ? ` [${label}]` : ''}: ${c.note}${c.answer ? ` (${c.answer})` : ''}`);
  }
  const wrong = candidates.filter(c => c.status === 'wrong-key').length;
  const probable = candidates.filter(c => c.status === 'probable').length;
  if (host) {
    say(`Found your controller at ${host}.`);
  } else if (!candidates.length) {
    say('No devices answered on the Tuya port. Check the controller is powered and on the same network as Homebridge'
      + ' (in Docker, Homebridge needs host networking).');
  } else if (key && wrong) {
    say(`${wrong > 1 ? `Found ${wrong} Tuya devices, but none accepted` : 'Found a Tuya device, but it did not accept'} this Local Key. `
      + 'If the plugin worked with this key recently, the controller may be holding an old connection: unplug it for 10 seconds. '
      + 'Otherwise its key changed (reset or re-added in the Gouly app): get the keys again.');
  } else if (!key) {
    say(`Found ${probable || candidates.length} likely device${(probable || candidates.length) > 1 ? 's' : ''}. `
      + 'Add the Device ID and Local Key, then search again to confirm which one is yours.');
  } else {
    const own = candidates.find(c => id && c.announcedId === id);
    say(own ? `Your controller announced itself at ${own.ip} but is not accepting connections right now. Try again in a few `
      + 'minutes; if this keeps happening, check its Wi-Fi signal.' : 'None of these accepted the Device ID and Local Key.');
  }
  return { host, candidates };
}
