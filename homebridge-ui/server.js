// Settings UI backend. Talks to the running plugin through small files in
// Homebridge storage (see src/patterns/control.ts) and runs network discovery.
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import fsSync, { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { guidedSearch, scanForTuyaHosts } = require('../dist/discovery.js');

const DEFAULT_RECORD_MINUTES = 15;

/** Remove terminal colour codes from Homebridge log lines. */
// eslint-disable-next-line no-control-regex
const stripAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, '');

class GoulyUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.dir = path.join(this.homebridgeStoragePath, 'gouly');
    this.watchers = new Map();

    this.onRequest('/captured', ({ deviceId }) => this.readJson(this.file('captured', deviceId), []));
    this.onRequest('/clear', ({ deviceId }) => this.remove(this.file('captured', deviceId)).then(() => []));
    this.onRequest('/delete-captured', ({ deviceId, frame }) => this.deleteCaptured(deviceId, frame));

    this.onRequest('/record/start', ({ deviceId, minutes }) => this.startRecording(deviceId, minutes));
    this.onRequest('/record/stop', ({ deviceId }) => this.stopRecording(deviceId));
    this.onRequest('/record/status', ({ deviceId }) => this.recordStatus(deviceId));

    this.onRequest('/preview', ({ deviceId, frame }) =>
      this.writeJson(this.file('preview', deviceId), { frame: frame ?? null, at: new Date().toISOString() }));

    this.onRequest('/find', body => this.find(body));
    this.onRequest('/info', ({ deviceId }) => this.readJson(this.file('info', deviceId), null));
    this.onRequest('/refresh', ({ deviceId }) => this.writeJson(this.file('refresh', deviceId), { at: new Date().toISOString() }));
    this.onRequest('/report', body => this.report(body));
    this.onRequest('/scan', async () => ({ hosts: await scanForTuyaHosts() }));
    this.onRequest('/about', () => this.about());

    // Homebridge ends this process when the settings window closes (Save, Close or
    // the X). Stop any recording and any "Show on house" preview at that point, so
    // nothing keeps running in the background.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.endSessions();
    };
    process.on('exit', cleanup);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(sig, () => { cleanup(); process.exit(0); });
    }
    process.on('disconnect', () => { cleanup(); process.exit(0); });

    this.ready();
  }

  /** Synchronous, because it runs while the process is exiting. */
  endSessions() {
    let names = [];
    try { names = fsSync.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        if (name.startsWith('recording-')) {
          fsSync.rmSync(file, { force: true });
        } else if (name.startsWith('preview-')) {
          const cur = JSON.parse(fsSync.readFileSync(file, 'utf8'));
          if (cur && cur.frame) {
            fsSync.writeFileSync(file, JSON.stringify({ frame: null, at: new Date().toISOString() }));
          }
        }
      } catch {
        // best effort while shutting down
      }
    }
  }

  file(kind, deviceId) {
    if (!/^[A-Za-z0-9_-]+$/.test(deviceId ?? '')) throw new RequestError('Invalid device id', { status: 400 });
    return path.join(this.dir, `${kind}-${deviceId}.json`);
  }

  async readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
  }

  async writeJson(file, data) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
    await fs.rename(`${file}.tmp`, file);
    return data;
  }

  remove(file) {
    return fs.rm(file, { force: true });
  }

  async deleteCaptured(deviceId, frame) {
    const file = this.file('captured', deviceId);
    const list = (await this.readJson(file, [])).filter(e => e.frame !== frame);
    await this.writeJson(file, list);
    return list;
  }

  async startRecording(deviceId, minutes = DEFAULT_RECORD_MINUTES) {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    const state = await this.writeJson(this.file('recording', deviceId), { until, startedAt: new Date().toISOString() });
    this.watchCaptured(deviceId, Date.parse(until));
    return state;
  }

  /** Also resumes live updates when the settings page is reopened mid-recording. */
  async recordStatus(deviceId) {
    const rec = await this.readJson(this.file('recording', deviceId), null);
    const until = rec ? Date.parse(rec.until) : 0;
    if (until > Date.now() && !this.watchers.has(deviceId)) this.watchCaptured(deviceId, until);
    return rec;
  }

  async stopRecording(deviceId) {
    await this.remove(this.file('recording', deviceId));
    clearInterval(this.watchers.get(deviceId));
    this.watchers.delete(deviceId);
    return null;
  }

  /** While recording, push the recorded list to the UI whenever the plugin adds to it. */
  watchCaptured(deviceId, until) {
    clearInterval(this.watchers.get(deviceId));
    const file = this.file('captured', deviceId);
    let lastMtime = 0;
    const timer = setInterval(async () => {
      if (Date.now() > until) {
        this.pushEvent('recording-ended', { deviceId });
        return this.stopRecording(deviceId);
      }
      try {
        const { mtimeMs } = await fs.stat(file);
        if (mtimeMs !== lastMtime) {
          lastMtime = mtimeMs;
          this.pushEvent('captured', { deviceId, list: await this.readJson(file, []) });
        }
      } catch { /* nothing recorded yet */ }
    }, 1000);
    this.watchers.set(deviceId, timer);
  }

  /** Version and project links for the footer, read from package.json. */
  about() {
    const pkg = require('../package.json');
    const clean = u => String(u || '').replace(/^git\+/, '').replace(/\.git$/, '');
    const repo = clean(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
    const funding = typeof pkg.funding === 'string' ? pkg.funding : pkg.funding?.url;
    return {
      version: pkg.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      repo,
      issues: clean(typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url) || (repo ? `${repo}/issues` : ''),
      funding: funding || '',
    };
  }

  /** Narrated network search; each line is pushed to the page and saved for the debug report. */
  async find({ deviceId, localKey, protocolVersion, host, pythonPath }) {
    const lines = [];
    const onLine = line => {
      const stamped = `${new Date().toISOString().slice(11, 19)}  ${line}`;
      lines.push(stamped);
      this.pushEvent('find-progress', { line: stamped });
    };
    const result = await guidedSearch({ id: deviceId, key: localKey, version: protocolVersion || '3.4',
      hint: host || undefined, pythonPath, onLine });
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, 'find-last.json'),
      JSON.stringify({ at: new Date().toISOString(), deviceId: deviceId || null, lines, candidates: result.candidates }, null, 2));
    return { host: result.host ?? null, candidates: result.candidates };
  }

  // ------------------------------------------------------------ debug report

  /**
   * One text file with everything needed to diagnose a problem. The local key is
   * never included: every configured key value is replaced wherever it appears.
   * maskNetwork hides IP and MAC addresses except the last IP octet and the MAC
   * vendor prefix.
   */
  async report({ platform, maskNetwork }) {
    const devices = Array.isArray(platform?.devices) ? platform.devices : [];
    const out = [];
    const section = title => out.push('', `==== ${title} ${'='.repeat(Math.max(4, 70 - title.length))}`);
    const kv = (k, v) => out.push(`${(k + ':').padEnd(22)} ${v ?? '-'}`);

    const pkg = require('../package.json');
    out.push(`homebridge-gouly debug report, generated ${new Date().toISOString()}`);
    out.push('The Local Key is never included. Attach this file to your GitHub issue.');

    section('Environment');
    kv('Plugin version', pkg.version);
    kv('Homebridge', this.homebridgeVersion());
    kv('Homebridge UI', process.env.HOMEBRIDGE_UI_VERSION);
    kv('Node.js', process.version);
    kv('OS', `${os.type()} ${os.release()} ${os.arch()}${fsSync.existsSync('/.dockerenv') ? ' (Docker)' : ''}`);
    kv('Python', await this.pythonInfo(devices[0]?.pythonPath));

    for (const d of devices) {
      section(`Controller: ${d.name || 'Unnamed'}`);
      kv('Device ID', d.deviceId || 'MISSING');
      kv('Local Key', d.localKey ? `set (${String(d.localKey).length} characters)` : 'MISSING');
      kv('IP address (config)', d.host || 'not set (automatic search)');
      kv('Protocol (config)', d.protocolVersion || '3.4');
      kv('Controller type', d.controllerType || 'auto');
      kv('Options', ['powerSwitch', 'adaptiveLighting', 'groupsEnabled', 'verboseLogging']
        .map(k => `${k}=${d[k] ?? 'default'}`).join(', '));
      kv('Pattern switch off', d.patternOffAction || 'restore');
      kv('Patterns in HomeKit', (d.patterns || []).length);
      if (d.groupsEnabled) kv('Groups', (d.groups || []).map(g => `${g.name} [${g.id}]`).join(', ') || 'default only');
      for (const p of d.patterns || []) out.push(`  - ${p.name}${p.group ? ` (group ${p.group})` : ''}: ${p.frame}`);

      const info = d.deviceId ? await this.readJson(this.file('info', d.deviceId), null) : null;
      out.push('', '-- What the plugin last learned from the controller');
      if (!info) {
        out.push('  No data yet: the plugin has not run with this controller since it was added.');
      } else {
        for (const k of ['updated', 'type', 'host', 'protocol', 'firmware', 'pixels', 'icType', 'rgbOrder',
          'lastStateReport', 'lastStateAt', 'connectedSince', 'connects', 'disconnects', 'lastError']) kv(`  ${k}`, info[k]);
        out.push('', '-- Unrecognized commands', ...(info.unrecognized.length ? info.unrecognized.map(f => `  ${f}`) : ['  none']));
        out.push('', '-- Recent events', ...info.events.map(e => `  ${e}`));
        out.push('', '-- Recent frames (-> sent, <- received)', ...info.frames.map(f => `  ${f}`));
      }
      const captured = d.deviceId ? await this.readJson(this.file('captured', d.deviceId), []) : [];
      const norm = f => String(f || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
      const inHomeKit = new Set((d.patterns || []).flatMap(p => [norm(p.frame), norm(p.sourceFrame)]).filter(Boolean));
      const pending = captured.filter(c => !inHomeKit.has(norm(c.frame)));
      out.push('', `-- Recorded list: ${captured.length} recorded, ${captured.length - pending.length} already in HomeKit, `
        + `${pending.length} not added`);
      for (const c of pending) out.push(`  - ${c.suggestedName}: ${c.frame}`);
    }

    section('Last network search');
    const find = await this.readJson(path.join(this.dir, 'find-last.json'), null);
    out.push(...(find ? [`  ${find.at}`, ...find.lines.map(l => `  ${l}`)] : ['  No search has been run.']));

    section('Homebridge log (Gouly lines, most recent last)');
    out.push(...(await this.goulyLogLines()));

    let text = out.join('\n') + '\n';
    for (const d of devices) {
      if (d.localKey && String(d.localKey).length >= 4) text = text.split(String(d.localKey)).join('[LOCAL KEY REMOVED]');
    }
    if (maskNetwork) {
      text = text
        .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a, b, c, d) => (a === '0' ? m : `x.x.x.${d}`))
        .replace(/\b([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}):[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}\b/gi, '$1:xx:xx:xx');
    }
    return { text, filename: `homebridge-gouly-debug-${new Date().toISOString().slice(0, 10)}.txt` };
  }

  /** Installed Homebridge version, from the usual install locations (Docker, hb-service, npm -g). */
  homebridgeVersion() {
    const roots = ['/opt/homebridge/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules',
      path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'),
      path.join(this.homebridgeStoragePath || '', 'node_modules')];
    for (const root of roots) {
      try {
        return JSON.parse(fsSync.readFileSync(path.join(root, 'homebridge', 'package.json'), 'utf8')).version;
      } catch {
        // try the next location
      }
    }
    return 'unknown';
  }


  pythonInfo(pythonPath) {
    const code = 'import sys\ntry:\n import cryptography; c="installed"\nexcept Exception:\n c="not installed (bundled pure-Python AES is used)"\nprint(sys.version.split()[0] + ", cryptography " + c)';
    return new Promise(resolve => execFile(pythonPath || 'python3', ['-c', code], { timeout: 5000 },
      (err, stdout) => resolve(err ? `not available (${err.code || err.message})` : stdout.trim())));
  }

  /** The last Gouly lines from the Homebridge log file, wherever this install keeps it. */
  async goulyLogLines(max = 400) {
    const storage = this.homebridgeStoragePath || '';
    for (const file of [path.join(storage, 'homebridge.log'), path.join(storage, 'logs', 'homebridge.log')]) {
      try {
        const text = await fs.readFile(file, 'utf8');
        // Plugin lines only; "Incoming Request" lines are the settings framework logging page requests.
        const lines = text.split('\n').filter(l => /gouly/i.test(l) && !/Incoming Request:/.test(l));
        return lines.length ? lines.slice(-max).map(l => `  ${stripAnsi(l)}`) : ['  (no Gouly lines in the log)'];
      } catch { /* try the next location */ }
    }
    return ['  (log file not found; copy the relevant lines from the Homebridge log screen instead)'];
  }

}

(() => new GoulyUiServer())();
