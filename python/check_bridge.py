#!/usr/bin/env python3
"""
Check the transport bridge against the real controller, using the Gouly settings
already saved in Homebridge (no need to type the key).

    python3 check_bridge.py [/homebridge/config.json]

Stop the Gouly child bridge first (the controller allows few connections).
Expected: "connected", then the lights go OFF for 3 s and back ON, with each
command echoed back.
"""
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = sys.argv[1] if len(sys.argv) > 1 else "/homebridge/config.json"

with open(CONFIG) as f:
    cfg = json.load(f)
gouly = next((p for p in cfg.get("platforms", []) if p.get("platform") == "Gouly"), None)
if not gouly or not gouly.get("devices"):
    sys.exit("No Gouly controller found in " + CONFIG)
dev = gouly["devices"][0]
print("Controller: %s at %s (protocol %s), key length %d" % (
    dev.get("name"), dev.get("host"), dev.get("protocolVersion", "3.4"), len(dev.get("localKey", ""))))

bridge_cfg = json.dumps({"id": dev["deviceId"], "key": dev["localKey"],
                         "host": dev["host"], "version": dev.get("protocolVersion", "3.4")})
proc = subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "gouly_bridge.py")],
                        env={**os.environ, "GOULY_BRIDGE_CONFIG": bridge_cfg},
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
connected = threading.Event()


def reader():
    for line in proc.stdout:
        msg = json.loads(line)
        ev = msg.get("event")
        if ev == "connected":
            connected.set()
            print("connected to", msg.get("host"))
        elif ev == "frame":
            print("  <- echo", msg["hex"])
        elif ev == "switch":
            print("  <- power is", "ON" if msg["on"] else "OFF")
        elif ev == "log" and "->" in msg.get("msg", ""):
            print("  " + msg["msg"])
        elif ev in ("disconnected", "unreachable"):
            print(ev, msg.get("reason", ""))
        elif ev == "log" and msg.get("level") != "debug":
            print(msg.get("msg"))


threading.Thread(target=reader, daemon=True).start()


def send(*frames):
    proc.stdin.write(json.dumps({"cmd": "send", "frames": list(frames)}) + "\n")
    proc.stdin.flush()


if not connected.wait(15):
    print("Could not connect within 15 s. Is the Gouly child bridge stopped, and is the controller powered?")
else:
    print("Lights OFF...")
    send("aaf10000000000000000006d")
    time.sleep(3)
    print("Lights ON...")
    send("aaf10100000000000000002e")
    time.sleep(3)
proc.stdin.write(json.dumps({"cmd": "stop"}) + "\n")
proc.stdin.flush()
proc.wait(timeout=5)
print("done")
