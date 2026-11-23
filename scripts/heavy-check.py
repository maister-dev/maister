"""Acquire one host-local validation slot, then replace this process with the check."""

import fcntl
import json
import os
import re
import sys
import time
from pathlib import Path


def acquire_slot(directory: Path, limit: int) -> int:
    directory.mkdir(mode=0o700, exist_ok=True)
    root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(root)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError(
                f"Expected a private lock directory owned by this user: {directory}"
            )
        waiting = False
        while True:
            for slot in range(limit):
                fd = os.open(
                    str(slot), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root
                )
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    os.close(fd)
                    continue
                return fd
            if not waiting:
                print(
                    json.dumps({"event": "heavy_check_waiting", "limit": limit, "directory": str(directory)}),
                    file=sys.stderr,
                    flush=True,
                )
                waiting = True
            time.sleep(0.25)
    finally:
        os.close(root)


def main() -> None:
    value = os.environ["MAISTER_MAX_CONCURRENT_HEAVY_CHECKS"]
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise ValueError("MAISTER_MAX_CONCURRENT_HEAVY_CHECKS must be a positive integer")
    directory = Path(
        os.environ.get("MAISTER_HEAVY_CHECK_DIR", f"/tmp/maister-heavy-checks-{os.getuid()}")
    )
    if not directory.is_absolute():
        raise ValueError("MAISTER_HEAVY_CHECK_DIR must be absolute")
    command = sys.argv[1:]
    if not command:
        raise ValueError("Expected a heavy-check command and its arguments")
    descriptor = acquire_slot(directory, int(value))
    # The kernel releases the lock when the check exits, including on SIGKILL.
    os.set_inheritable(descriptor, True)
    os.execvp(command[0], command)


if __name__ == "__main__":
    main()
