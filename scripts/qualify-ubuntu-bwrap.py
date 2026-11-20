"""Synthetic namespace and relay witness for the disposable Ubuntu P0 guest."""

import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading


CLIENT = """
import json
from pathlib import Path
import socket
import sys

tcp_port = int(sys.argv[1])
def read_tcp():
    try:
        with socket.create_connection(('127.0.0.1', tcp_port), timeout=1) as conn:
            return conn.recv(7).decode()
    except OSError as error:
        return error.errno

def read_relay():
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(1)
        conn.connect(sys.argv[2])
        return conn.recv(7).decode()

print(json.dumps({
    'direct': read_tcp(),
    'relay': read_relay(),
    'outside_file': Path(sys.argv[3]).is_file(),
    'network_namespace': str(Path('/proc/self/ns/net').readlink()),
}))
"""

DROP = [
    '/usr/bin/setpriv', '--reuid=11032', '--regid=11032', '--clear-groups',
    '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all',
    '--no-new-privs', '--',
]


def serve(listener: socket.socket, expected_connections: int) -> None:
    listener.settimeout(5)
    for _ in range(expected_connections):
        with listener.accept()[0] as connection:
            connection.sendall(b'fixture')


with tempfile.TemporaryDirectory(prefix='maister-p0-bwrap-') as directory:
    root = Path(directory)
    root.chmod(0o755)
    outside_file = root / 'outside'
    outside_file.write_text('synthetic')
    relay_path = root / 'relay.sock'

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as relay:
        tcp.bind(('127.0.0.1', 0))
        relay.bind(str(relay_path))
        relay_path.chmod(0o777)
        for listener in (tcp, relay):
            listener.listen()

        tcp_port = str(tcp.getsockname()[1])
        threads = [
            threading.Thread(target=serve, args=(tcp, 1), daemon=True),
            threading.Thread(target=serve, args=(relay, 2), daemon=True),
        ]
        for thread in threads:
            thread.start()

        outside = json.loads(subprocess.check_output(
            DROP + ['/usr/bin/python3', '-c', CLIENT, tcp_port, str(relay_path), str(outside_file)],
            cwd=root, timeout=8, text=True,
        ))
        assert outside['direct'] == outside['relay'] == 'fixture', outside
        assert outside['outside_file'] is True, outside
        bwrap = [
            '/usr/bin/bwrap', '--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled',
            '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc',
            '--ro-bind', str(relay_path), '/relay.sock',
            '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
            '--', '/usr/bin/python3', '-c', CLIENT, tcp_port, '/relay.sock', str(outside_file),
        ]
        inside = json.loads(subprocess.check_output(DROP + bwrap, cwd=root, timeout=8, text=True))
        assert inside['relay'] == 'fixture' and isinstance(inside['direct'], int), inside
        assert inside['outside_file'] is False, inside
        assert inside['network_namespace'] != outside['network_namespace'], inside
        for thread in threads:
            thread.join()
        print('bwrap_relay_and_direct_denial=verified')
