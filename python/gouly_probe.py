#!/usr/bin/env python3
"""
Identify Tuya devices on the local network, with or without the Local Key.
Used by Find (src/discovery.ts).

probe(host, key, dev_id)
    Keyless fingerprint, the method tinytuya's scanner uses: open TCP 6668 and
    send an unencrypted status query.
        protocol 3.1 devices answer with their status,
        protocol 3.3 devices answer with an encrypted rejection,
        protocol 3.4 and 3.5 devices (Gouly controllers) close the connection.
    With a key, it also starts a protocol 3.4 session handshake signed with that
    key. Only a device holding the same key answers it with a correctly signed
    reply; a device with a different key closes the connection or stays silent.
    If that fails, a protocol 3.3 (and 3.5, when AES-GCM is available) status
    request is tried, as ha-gouly does.
    Gouly controllers are slow, so every step allows several seconds.

listen_udp(stop)
    Collects Tuya discovery broadcasts (UDP 6666, 6667, 7000) and asks protocol
    3.5 devices to announce themselves. Gouly controllers have not been seen
    broadcasting, but other firmware may; an announcement carries the Device ID,
    which identifies a device without any key.

Run as a script: configuration JSON {"id", "key", "listen": max seconds,
"timeout", "port"} in GOULY_PROBE_CONFIG (not argv, so the key stays out of process
listings). Each stdin line is an IP address to probe; closing stdin ends the run.
Prints one JSON object per line: {"event": "probe"|"udp"|"note"|"done", ...}.
The key is never printed.
"""
import contextlib
import io
import json
import os
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))
if os.environ.get("GOULY_BRIDGE_EXTRA_PATH"):  # tests: substitute a mock tinytuya
    sys.path.insert(0, os.environ["GOULY_BRIDGE_EXTRA_PATH"])

with contextlib.redirect_stdout(io.StringIO()):  # tinytuya warns on stdout without `requests`
    import tinytuya  # noqa: E402

TUYA_PORT = 6668
DUMMY_ID = "0" * 22
PREFIX_55AA = b"\x00\x00\x55\xaa"
PREFIX_6699 = b"\x00\x00\x66\x99"


def _recv_packet(sock, deadline):
    """Read one Tuya packet. Returns (data, how): how is "data", "closed" or "silent"."""
    data = b""
    while time.monotonic() < deadline:
        sock.settimeout(max(0.05, deadline - time.monotonic()))
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            return data, ("data" if data else "silent")
        except OSError:  # reset by the device
            return data, ("data" if data else "closed")
        if not chunk:
            return data, ("data" if data else "closed")
        data += chunk
        if len(data) >= 4 and data[:4] not in (PREFIX_55AA, PREFIX_6699):
            return data, "data"  # not a Tuya packet; no point waiting for more
        try:
            if len(data) >= tinytuya.parse_header(data).total_length:
                return data, "data"
        except Exception:
            continue  # header incomplete
    return data, ("data" if data else "silent")


def _exchange(host, port, payload, timeout):
    """Connect, send, read one reply. Returns (state, data): state is
    "closed-port", "timeout", "unreachable", "data", "closed" or "silent"."""
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except ConnectionRefusedError:
        return "closed-port", b""
    except socket.timeout:
        return "timeout", b""
    except OSError:
        return "unreachable", b""
    try:
        sock.sendall(payload)
        data, how = _recv_packet(sock, time.monotonic() + timeout)
        return how, data
    except OSError:
        return "closed", b""
    finally:
        with contextlib.suppress(Exception):
            sock.close()


def fingerprint(host, port=TUYA_PORT, timeout=5.0):
    """Keyless check. Returns a dict: port, tuya ("yes"|"likely"|"no"), protocol, answer."""
    query = tinytuya.pack_message(tinytuya.TuyaMessage(1, tinytuya.DP_QUERY, 0, b"", 0, True, 0x55AA, None))
    state, data = _exchange(host, port, query, timeout)
    out = {"port": "open", "tuya": "no", "protocol": None}
    if state in ("closed-port", "timeout", "unreachable"):
        out["port"] = {"closed-port": "closed"}.get(state, state)
        out["answer"] = {"closed-port": "port closed", "timeout": "no answer", "unreachable": "unreachable"}[state]
        return out
    if state == "closed":
        out.update(tuya="likely", answer="closed the connection, as protocol 3.4 and 3.5 Tuya devices do")
    elif state == "silent":
        out["answer"] = "connected, but did not reply"
    elif data[:4] == PREFIX_6699:
        out.update(tuya="yes", protocol="3.5", answer="replied as a protocol 3.5 Tuya device")
    elif data[:4] == PREFIX_55AA:
        out.update(tuya="yes", answer="replied as a protocol 3.1 to 3.3 Tuya device")
    else:
        out["answer"] = "replied, but not like a Tuya device"
    return out


def key_check(host, key, dev_id=None, port=TUYA_PORT, timeout=5.0, try_33=True):
    """Does the device at host hold this key? Returns (result, protocol, answer):
    result "ok" or "wrong"."""
    d = tinytuya.Device(dev_id or DUMMY_ID, host, key, version=3.4)
    step1 = d._encode_message(d._negotiate_session_key_generate_step_1())
    state, data = _exchange(host, port, step1, timeout)
    if state == "data":
        try:
            header = tinytuya.parse_header(data)
            if header.prefix == tinytuya.PREFIX_6699_VALUE:
                return _status_check(host, key, dev_id, 3.5, timeout, "replied as a protocol 3.5 device")
            if header.cmd == tinytuya.SESS_KEY_NEG_RESP:
                msg = tinytuya.unpack_message(data, hmac_key=d.local_key, header=header)
                if msg.crc_good and d._negotiate_session_key_generate_step_3(msg) is not False:
                    return "ok", "3.4", "accepted the Local Key (protocol 3.4)"
                return "wrong", "3.4", "answered, but signed with a different Local Key"
        except Exception:
            pass
    if state in ("closed-port", "timeout", "unreachable"):
        return "wrong", None, "could not connect for the key check"
    if try_33 and state != "closed":  # 3.3 devices answer a 3.4 handshake rather than close
        time.sleep(0.3)  # let a slow controller settle before the next connection
        result = _status_check(host, key, dev_id, 3.3, timeout, None)
        if result[0] == "ok":
            return result
    how = {"closed": "closed the connection", "silent": "did not answer"}.get(state, "did not complete")
    return "wrong", None, "%s when sent the Local Key" % how


def _status_check(host, key, dev_id, version, timeout, answer):
    if version == 3.5 and not tinytuya.AESCipher.CRYPTOLIB_HAS_GCM:
        return "wrong", "3.5", (answer or "protocol 3.5") + "; checking its key needs the Python 'cryptography' package"
    d = tinytuya.Device(dev_id or DUMMY_ID, host, key, version=version, connection_timeout=timeout)
    d.set_socketRetryLimit(1)
    try:
        status = d.status()
    except Exception:
        status = None
    finally:
        with contextlib.suppress(Exception):
            d.close()
    if isinstance(status, dict) and "Error" not in status:
        return "ok", str(version), "accepted the Local Key (protocol %s)" % version
    return "wrong", str(version) if answer else None, answer or "did not accept the Local Key"


def probe(host, key=None, dev_id=None, port=TUYA_PORT, timeout=5.0):
    """Classify one host. Never raises. Keys: ip, port, tuya, protocol, key, answer, ms."""
    started = time.monotonic()
    result = {"ip": host, "key": "none"}
    try:
        if key and len(key) == 16:
            verdict, protocol, answer = key_check(host, key, dev_id, port, timeout)
            if verdict == "ok":
                result.update(port="open", tuya="yes", protocol=protocol, key="ok", answer=answer)
                return result
            time.sleep(0.3)
            result.update(fingerprint(host, port, timeout))
            if result["port"] == "open":
                result["key"] = "wrong"
                result["keyAnswer"] = answer
                if protocol and not result.get("protocol"):
                    result["protocol"] = protocol
        else:
            if key:
                result["keyAnswer"] = "the Local Key must be 16 characters"
            result.update(fingerprint(host, port, timeout))
    except Exception as e:  # report what we know
        result.setdefault("port", "open")
        result.setdefault("tuya", "no")
        result["answer"] = "probe error: %s" % e
    finally:
        result["ms"] = int((time.monotonic() - started) * 1000)
    return result


# ---------------------------------------------------------------- UDP announcements

def _local_ipv4_addresses():
    addrs = set()
    with contextlib.suppress(OSError):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent
            addrs.add(s.getsockname()[0])
    return [a for a in addrs if not a.startswith("127.")]


def listen_udp(stop, max_seconds, on_device, on_note):
    """Collect Tuya discovery broadcasts until stop is set (or max_seconds pass)."""
    socks = []
    for port in (tinytuya.UDPPORT, tinytuya.UDPPORTS, tinytuya.UDPPORTAPP):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            with contextlib.suppress(OSError):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try:
            s.bind(("", port))
        except OSError as e:
            on_note("could not listen on UDP %d (%s)" % (port, e.strerror or e))
            s.close()
            continue
        s.settimeout(0.2)
        socks.append(s)

    if tinytuya.AESCipher.CRYPTOLIB_HAS_GCM:
        # Protocol 3.5 devices announce themselves when asked on port 7000.
        for addr in _local_ipv4_addresses():
            with contextlib.suppress(Exception):
                req = json.dumps({"from": "app", "ip": addr}).encode()
                msg = tinytuya.TuyaMessage(0, tinytuya.REQ_DEVINFO, None, req, 0, True, tinytuya.PREFIX_6699_VALUE, True)
                payload = tinytuya.pack_message(msg, hmac_key=tinytuya.udpkey)
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as b:
                    b.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                    b.sendto(payload, ("255.255.255.255", tinytuya.UDPPORTAPP))

    seen = set()
    deadline = time.monotonic() + max_seconds
    while socks and not stop.is_set() and time.monotonic() < deadline:
        for s in socks:
            try:
                data, (ip, _) = s.recvfrom(4096)
            except (socket.timeout, OSError):
                continue
            try:
                info = json.loads(tinytuya.decrypt_udp(data))
            except Exception:
                info = {}
            if info.get("from") == "app":
                continue  # an app's discovery request, not a device
            dev_id = info.get("gwId") or info.get("id")
            ident = (info.get("ip") or ip, dev_id)
            if ident in seen:
                continue
            seen.add(ident)
            on_device({"ip": info.get("ip") or ip, "id": dev_id, "version": info.get("version"),
                       "productKey": info.get("productKey")})
    for s in socks:
        s.close()


def main():
    cfg = json.loads(os.environ.get("GOULY_PROBE_CONFIG") or "{}")
    key, dev_id = cfg.get("key") or None, cfg.get("id") or None
    timeout = float(cfg.get("timeout", 5))
    port = int(cfg.get("port", TUYA_PORT))  # tests use another port
    lock = threading.Lock()

    def out(**event):
        with lock:
            sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
            sys.stdout.flush()

    stop = threading.Event()
    listener = None
    if cfg.get("listen"):
        listener = threading.Thread(target=listen_udp, daemon=True, args=(
            stop, float(cfg["listen"]), lambda dev: out(event="udp", **dev), lambda t: out(event="note", text=t)))
        listener.start()

    with ThreadPoolExecutor(max_workers=8) as pool:
        for line in sys.stdin:
            host = line.strip()
            if host:
                pool.submit(lambda h: out(event="probe", **probe(h, key, dev_id, port, timeout)), host)
    stop.set()
    if listener:
        listener.join(2)
    out(event="done")


if __name__ == "__main__":
    main()
