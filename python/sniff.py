#!/usr/bin/env python3
"""
Log every frame a Gouly controller sends, with the command name, using the
settings already saved in Homebridge. Useful for bug reports and for adding
support for other controller models or firmware.

    python3 sniff.py [/path/to/homebridge/config.json]

Stop the plugin's child bridge first (the controller allows few connections),
then use the Gouly app: every command it sends is echoed and printed here.
Ctrl-C to stop. Output never includes the local key.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = sys.argv[1] if len(sys.argv) > 1 else "/homebridge/config.json"

NAMES = {
    "aaf1": "power", "aaf2": "color", "aaf3": "brightness", "aaf6": "pattern",
    "aae5": "commit", "aafc": "state query", "bbfc": "state report",
    "aaee": "clock and location", "bbee": "clock reply", "aaef": "unknown (sent on app start)",
    "aaf7": "RGB order", "aaf8": "pixel count", "aafa": "IC type",
    "aae1": "schedule list", "bbe1": "schedule", "aafd": "schedule write", "aae6": "schedule delete",
    "aab6": "Pro state query", "bbb6": "Pro state report",
}

with open(CONFIG) as f:
    cfg = json.load(f)
gouly = next((p for p in cfg.get("platforms", []) if p.get("platform") == "Gouly"), None)
devices = (gouly or {}).get("devices") or []
if not devices:
    sys.exit("No Gouly controller found in " + CONFIG)
dev = devices[0]
print("Controller: %s at %s (protocol %s)" % (dev.get("name"), dev.get("host"), dev.get("protocolVersion", "3.4")))

env = {**os.environ, "GOULY_BRIDGE_CONFIG": json.dumps({
    "id": dev["deviceId"], "key": dev["localKey"], "host": dev["host"],
    "version": dev.get("protocolVersion", "3.4")})}
proc = subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "gouly_bridge.py")],
                        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
print("Listening. Use the Gouly app now; Ctrl-C to stop.\n")
try:
    for line in proc.stdout:
        msg = json.loads(line)
        ev = msg.get("event")
        stamp = time.strftime("%H:%M:%S")
        if ev == "frame":
            hexs = msg["hex"]
            name = NAMES.get(hexs[:4], "unrecognized")
            print("%s  %-26s %s" % (stamp, name, " ".join(hexs[i:i + 2] for i in range(0, len(hexs), 2))))
        elif ev == "switch":
            print("%s  %-26s %s" % (stamp, "power (DP 20)", "on" if msg["on"] else "off"))
        elif ev in ("connected", "disconnected", "unreachable"):
            print("%s  -- %s %s" % (stamp, ev, msg.get("host") or msg.get("reason") or ""))
except KeyboardInterrupt:
    pass
finally:
    try:
        proc.stdin.write(json.dumps({"cmd": "stop"}) + "\n")
        proc.stdin.flush()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
