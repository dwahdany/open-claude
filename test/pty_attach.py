# /// script
# requires-python = ">=3.10"
# dependencies = ["pexpect"]
# ///
"""Drive the stock opencode TUI against the shim in a PTY and capture what it renders."""
import os
import re
import sys
import time

import pexpect

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4096"
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "/tmp/oc-test-proj"
PROMPT = sys.argv[3] if len(sys.argv) > 3 else "Say exactly: banana-4271. No tools."

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07")


def clean(buf: str) -> str:
    buf = ANSI.sub("", buf)
    return "".join(ch for ch in buf if ch == "\n" or ch >= " ")


env = dict(os.environ, TERM="xterm-256color", COLUMNS="120", LINES="40")
child = pexpect.spawn(
    "opencode",
    ["attach", URL, "--dir", DIRECTORY, "--log-level", "ERROR"],
    env=env,
    dimensions=(40, 120),
    encoding="utf-8",
    timeout=60,
)
capture: list[str] = []


def drain(seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        try:
            capture.append(child.read_nonblocking(65536, timeout=0.4))
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            capture.append("\n<<EOF>>\n")
            break


# 1. Let the TUI boot and reach the home screen.
drain(6)
booted = clean("".join(capture))
print("===== AFTER BOOT =====")
print(booted[-2500:])

# 2. Type the prompt and submit.
child.send(PROMPT)
time.sleep(1.0)
child.send("\r")

# 3. Watch the turn stream in.
drain(25)
final = clean("".join(capture))
print("===== AFTER PROMPT (tail) =====")
print(final[-3500:])

# 4. Quit.
try:
    child.sendcontrol("c")
    time.sleep(0.3)
    child.sendcontrol("c")
    child.close(force=True)
except Exception:
    pass

# Verdict markers for the harness to grep.
low = final.lower()
print("\n===== VERDICT =====")
print("MARKER_FOUND:", "banana-4271" in low or "banana" in low)
print("CONNECT_ERROR:", "connect a provider" in low or "unable to connect" in low or "not supported by this version" in low)
