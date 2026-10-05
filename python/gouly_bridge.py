#!/usr/bin/env python3
"""
Gouly transport bridge: holds the local Tuya connection with tinytuya (the
library proven against this controller) and speaks JSON lines with the plugin.

stdin  (plugin -> bridge), one JSON object per line:
  {"cmd": "send", "frames": ["aaf1...", ...]}   send Gouly frames on DP 101, in order
  {"cmd": "host", "host": "192.0.2.10"}          switch address and reconnect
  {"cmd": "stop"}                                close and exit

stdout (bridge -> plugin), one JSON object per line:
  {"event": "connected", "host": ...}
  {"event": "disconnected", "reason": ...}
  {"event": "unreachable"}                       several connect attempts failed
  {"event": "frame", "hex": "aaf101..."}         DP 101 frame from the controller
  {"event": "switch", "on": true}                DP 20
  {"event": "log", "level": "debug|info|warn", "msg": ...}

Configuration is JSON {"id","key","host","version"} in the GOULY_BRIDGE_CONFIG
environment variable (argv[1] is also accepted). The environment is used so the
local key does not appear in process listings.
The bridge exits when stdin closes (the plugin went away).
"""
import base64
import contextlib
import io
import json
import os
import queue
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))
if os.environ.get("GOULY_BRIDGE_EXTRA_PATH"):  # tests: substitute a mock tinytuya
    sys.path.insert(0, os.environ["GOULY_BRIDGE_EXTRA_PATH"])

# tinytuya prints a warning to stdout when `requests` is missing (only its Cloud
# API needs it). stdout is our message channel, so keep import noise off it.
with contextlib.redirect_stdout(io.StringIO()):
    import tinytuya  # noqa: E402

DP_TRANSPARENT = "101"
DP_SWITCH = "20"
FRAME_GAP = 0.2          # seconds between frames, like the Gouly app
HEARTBEAT_EVERY = 8.0    # Tuya devices drop idle connections
RECV_TIMEOUT = 0.5       # socket timeout while waiting for data
UNREACHABLE_AFTER = 4

_out_lock = threading.Lock()


def emit(**event):
    line = json.dumps(event, separators=(",", ":"))
    with _out_lock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            # The plugin went away (Homebridge stopped or restarted): exit quietly.
            os._exit(0)


def log(level, msg):
    emit(event="log", level=level, msg=msg)


class Bridge:
    def __init__(self, cfg):
        self.id = cfg["id"]
        self.key = cfg["key"]
        self.host = cfg.get("host")
        self.version = float(cfg.get("version", "3.4"))
        self.commands = queue.Queue()
        self.device = None
        self.running = True
        self.failures = 0
        self.backoff = 2.0
        self.warned_gcm = False

    # ------------------------------------------------------------ stdin
    def read_stdin(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.commands.put(json.loads(line))
            except ValueError:
                log("warn", "ignoring malformed command: " + line[:80])
        self.commands.put({"cmd": "stop"})  # plugin closed our stdin

    # ------------------------------------------------------------ connection
    def close(self):
        if self.device is not None:
            try:
                self.device.close()
            except Exception:
                pass
        self.device = None

    def versions_to_try(self):
        """Configured version first, then the others. Firmware varies between 3.3, 3.4 and 3.5."""
        order = [self.version] + [v for v in (3.4, 3.5, 3.3) if v != self.version]
        if tinytuya.CRYPTOLIB == "pyaes" and 3.5 in order:
            # Protocol 3.5 uses AES-GCM, which the bundled pure-Python AES lacks.
            order.remove(3.5)
            if self.version == 3.5 and not self.warned_gcm:
                self.warned_gcm = True
                log("warn", "Protocol 3.5 needs the Python 'cryptography' package: "
                            "run 'pip3 install cryptography' where Homebridge runs, then restart")
        return order

    def open_session(self, version):
        d = tinytuya.Device(self.id, self.host, self.key, version=version)
        d.set_socketPersistent(True)
        d.set_socketTimeout(RECV_TIMEOUT)
        d.set_socketRetryLimit(1)
        status = d.status()
        if isinstance(status, dict) and "Error" not in status:
            return d, status, None
        try:
            d.close()
        except Exception:
            pass
        err = status if isinstance(status, dict) else {"Error": repr(status)}
        return None, None, err

    def connect(self):
        """Open a persistent session; status() completes the handshake.

        A wrong protocol version fails the same way as a wrong key (Err 914), so on
        that error the other versions are tried before giving up.
        """
        self.close()
        last = None
        for version in self.versions_to_try():
            d, status, err = self.open_session(version)
            if d is not None:
                if version != self.version:
                    log("warn", "Connected using Tuya protocol %s, not the configured %s. "
                                "Set Tuya protocol to %s under Settings, Advanced." % (version, self.version, version))
                    self.version = version
                self.device = d
                self.failures = 0
                self.backoff = 2.0
                emit(event="connected", host=self.host, version=str(version))
                self.handle(status)
                return
            last = err
            if str(err.get("Err")) != "914":
                break  # a network error: other versions won't help
        raise ConnectionError(str((last or {}).get("Error", "connection failed")))

    def drop(self, reason):
        self.close()
        emit(event="disconnected", reason=reason)

    # ------------------------------------------------------------ data
    def handle(self, msg):
        if not isinstance(msg, dict):
            return
        dps = msg.get("dps")
        if not isinstance(dps, dict):
            return
        sw = dps.get(DP_SWITCH)
        if isinstance(sw, bool):
            emit(event="switch", on=sw)
        raw = dps.get(DP_TRANSPARENT)
        if isinstance(raw, str) and raw:
            try:
                emit(event="frame", hex=base64.b64decode(raw).hex())
            except Exception:
                log("debug", "undecodable DP 101 value: " + raw[:40])

    def receive_once(self):
        msg = self.device.receive()
        if not msg:
            return
        err = msg.get("Err") if isinstance(msg, dict) else None
        if err and str(err) != "904":  # 904 = nothing received before the timeout
            raise ConnectionError(msg.get("Error", "Err " + str(err)))
        self.handle(msg)

    def send_frames(self, frames):
        for i, hexframe in enumerate(frames):
            if i:
                self.drain_for(FRAME_GAP)
            data = bytes.fromhex(hexframe)
            log("debug", "-> " + hexframe)
            self.device.set_value(int(DP_TRANSPARENT), base64.b64encode(data).decode(), nowait=True)

    def drain_for(self, seconds):
        """Receive for a while so echoes are reported promptly between frames."""
        end = time.time() + seconds
        while time.time() < end:
            self.receive_once()

    # ------------------------------------------------------------ main loop
    def run(self):
        threading.Thread(target=self.read_stdin, daemon=True).start()
        last_beat = time.time()
        while self.running:
            if self.device is None:
                if not self.wait_for_command_or_timeout(0):
                    break
                if not self.host:
                    time.sleep(0.5)
                    continue
                try:
                    self.connect()
                    last_beat = time.time()
                except Exception as e:  # noqa: BLE001
                    self.failures += 1
                    log("debug", "connect failed: %s" % e)
                    if self.failures == UNREACHABLE_AFTER:
                        emit(event="unreachable")
                    if not self.wait_for_command_or_timeout(self.backoff):
                        break
                    self.backoff = min(self.backoff * 2, 60.0)
                continue

            try:
                # commands first, so HomeKit changes go out immediately
                while True:
                    try:
                        cmd = self.commands.get_nowait()
                    except queue.Empty:
                        break
                    if not self.apply(cmd):
                        return
                if self.device is None:
                    continue
                if time.time() - last_beat > HEARTBEAT_EVERY:
                    self.device.heartbeat(nowait=True)
                    last_beat = time.time()
                self.receive_once()
            except Exception as e:  # noqa: BLE001
                self.drop(str(e))
                self.wait_for_command_or_timeout(self.backoff)

    def wait_for_command_or_timeout(self, seconds):
        """While disconnected: honour host/stop commands; queue sends for later."""
        end = time.time() + seconds
        pending = []
        while True:
            remaining = end - time.time()
            try:
                cmd = self.commands.get(timeout=max(0.0, remaining)) if remaining > 0 else self.commands.get_nowait()
            except queue.Empty:
                break
            if cmd.get("cmd") == "stop":
                self.running = False
                return False
            if cmd.get("cmd") == "host":
                self.host = cmd.get("host")
                self.failures = 0
                self.backoff = 2.0
                break
            if cmd.get("cmd") == "send":
                pending.append(cmd)  # keep them; they go out once connected
        for cmd in pending:
            self.commands.put(cmd)
        return True

    def apply(self, cmd):
        kind = cmd.get("cmd")
        if kind == "send":
            self.send_frames(cmd.get("frames", []))
        elif kind == "host":
            self.host = cmd.get("host")
            self.drop("host changed")
        elif kind == "stop":
            self.running = False
            self.close()
            return False
        return True


def main():
    raw = os.environ.get("GOULY_BRIDGE_CONFIG") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not raw:
        sys.exit("gouly_bridge: no configuration (set GOULY_BRIDGE_CONFIG)")
    cfg = json.loads(raw)
    log("info", "bridge up (Python %s, tinytuya %s, crypto %s)" % (
        sys.version.split()[0], tinytuya.__version__, tinytuya.CRYPTOLIB))
    Bridge(cfg).run()


if __name__ == "__main__":
    main()
