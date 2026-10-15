#!/usr/bin/env python3
"""
A fake Tuya device on a local TCP port, for testing python/gouly_probe.py with the
real (vendored) tinytuya. Behaves like the documented device types:

  v34     protocol 3.4 (Gouly controllers): drops unencrypted queries; answers a
          session handshake only when it is signed with its own key; otherwise
          closes the connection, as tinytuya's scanner observes.
  v34bad  protocol 3.4 that answers a wrong-key handshake with a reply signed by
          its own key (also possible on some firmware).
  v33     protocol 3.3: answers anything with a 55AA packet.
  silent  accepts connections and never answers.
  other   not a Tuya device: answers with an HTTP error.

usage: fake_tuya_device.py MODE KEY [DELAY] [HOST] [PORT]   prints the port it listens on.
"""
import hmac
import os
import socket
import struct
import sys
import threading
import time
from hashlib import sha256

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "python", "vendor"))
import contextlib, io  # noqa: E401,E402
with contextlib.redirect_stdout(io.StringIO()):
    import tinytuya  # noqa: E402

MODE, KEY = sys.argv[1], sys.argv[2].encode()
DELAY = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0


def reply(cmd, payload, key):
    msg = tinytuya.TuyaMessage(1, cmd, None, struct.pack(">I", 0) + payload, 0, True, 0x55AA, None)
    return tinytuya.pack_message(msg, hmac_key=key)


def handle(conn):
    try:
        conn.settimeout(10)
        data = conn.recv(4096)
        if not data:
            return
        time.sleep(DELAY)  # slow controllers
        if MODE == "silent":
            time.sleep(8)
            return
        if MODE == "other":
            conn.sendall(b"HTTP/1.0 400 Bad Request\r\n\r\n")
            return
        if MODE == "v33":
            conn.sendall(reply(tinytuya.DP_QUERY, b"3.3" + b"\0" * 12 + os.urandom(16), None))
            return
        # protocol 3.4
        msg = tinytuya.unpack_message(data, hmac_key=KEY, no_retcode=True)
        if msg.cmd != tinytuya.SESS_KEY_NEG_START:
            return  # unencrypted query or anything else: close
        signed_ok = msg.crc_good
        if not signed_ok and MODE == "v34":
            return  # wrong key: close
        local_nonce = tinytuya.AESCipher(KEY).decrypt(msg.payload, False, decode_text=False) if signed_ok else os.urandom(16)
        remote_nonce = os.urandom(16)
        body = remote_nonce + hmac.new(KEY, local_nonce, sha256).digest()
        conn.sendall(reply(tinytuya.SESS_KEY_NEG_RESP, tinytuya.AESCipher(KEY).encrypt(body, False), KEY))
        if not signed_ok:
            time.sleep(0.5)
            return
        # Session: finish message, then answer status queries with DP 20 on.
        session = tinytuya.AESCipher(KEY).encrypt(bytes(a ^ b for a, b in zip(local_nonce, remote_nonce)), False, pad=False)
        buf = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
            while len(buf) >= 16:
                header = tinytuya.parse_header(buf)
                if len(buf) < header.total_length:
                    break
                packet, buf = buf[:header.total_length], buf[header.total_length:]
                if header.cmd in (tinytuya.DP_QUERY, tinytuya.DP_QUERY_NEW):
                    status = tinytuya.AESCipher(session).encrypt(b'{"dps":{"20":true}}', False)
                    conn.sendall(reply(header.cmd, status, session))
    except Exception:
        pass
    finally:
        conn.close()


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    host = sys.argv[4] if len(sys.argv) > 4 else "127.0.0.1"
    srv.bind((host, int(sys.argv[5]) if len(sys.argv) > 5 else 0))
    srv.listen(8)
    print(srv.getsockname()[1], flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
