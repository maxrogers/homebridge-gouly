"""Minimal stand-in for tinytuya used by the bridge tests. The controller echoes every DP 101 write."""
import json, os, time
__version__ = "mock"
CRYPTOLIB = "mock"
_LOG = os.environ.get("MOCK_TUYA_LOG")

def _record(entry):
    if _LOG:
        with open(_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")

class Device:
    def __init__(self, dev_id, address=None, local_key="", version=3.3):
        self.address, self.key, self.version = address, local_key, version
        self.inbox, self.timeout = [], 0.2
    def set_socketPersistent(self, p): pass
    def set_socketRetryLimit(self, n): pass
    def set_socketTimeout(self, s): self.timeout = s
    def status(self):
        _record({"op": "status", "host": self.address, "key": self.key, "version": self.version})
        if self.address == "10.0.0.250":
            return {"Error": "Network Error: Unable to Connect", "Err": "901"}
        want = os.environ.get("MOCK_TUYA_VERSION")
        if want and float(want) != float(self.version):
            return {"Error": "Check device key or version", "Err": "914"}
        return {"dps": {"20": True}}
    def set_value(self, index, value, nowait=False):
        _record({"op": "set", "index": index, "value": value, "host": self.address})
        self.inbox.append({"dps": {str(index): value}})
    def receive(self):
        # Tests can inject frames "from the Gouly app or controller": a file of hex lines.
        inject = os.environ.get("MOCK_TUYA_INJECT")
        if inject and os.path.exists(inject):
            import base64
            with open(inject) as f:
                lines = [l.strip() for l in f if l.strip()]
            os.remove(inject)
            for hexframe in lines:
                self.inbox.append({"dps": {"101": base64.b64encode(bytes.fromhex(hexframe)).decode()}})
        if self.inbox:
            return self.inbox.pop(0)
        time.sleep(min(self.timeout, 0.05))
        return {"Error": "Timeout Waiting for Device", "Err": "904"}
    def heartbeat(self, nowait=True): _record({"op": "heartbeat"})
    def close(self): _record({"op": "close"})
