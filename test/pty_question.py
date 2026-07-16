# /// script
# requires-python = ">=3.10"
# dependencies = ["pexpect", "pyte"]
# ///
"""Drive the stock opencode TUI against the shim in a PTY and verify the
AskUserQuestion dialog: option previews (quote-barred lines) and the synthetic
Notes tab (No note / Type your own answer / custom note round-trip)."""
import os
import re
import sys
import time

import pexpect
import pyte

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4123"
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "/tmp/oc-pty-question"
PROMPT = sys.argv[3] if len(sys.argv) > 3 else (
    'Call the AskUserQuestion tool ONCE with exactly one question: '
    'question "Which fruit should I buy?", header "Fruit", multiSelect false, '
    'and two options: (1) label "Apples", description "Red fruit", preview field '
    'of exactly 5 lines "P1".."P5" each on its own line; '
    '(2) label "Bananas", description "Yellow fruit", no preview. '
    'After the tool result arrives, reply with the single word DONE.'
)
NOTE = "pty-note-9931"

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
    timeout=120,
)

screen = pyte.Screen(120, 40)
stream = pyte.Stream(screen)
capture: list[str] = []
snapshots: dict[str, str] = {}


def drain(seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        try:
            chunk = child.read_nonblocking(65536, timeout=0.4)
            capture.append(chunk)
            stream.feed(chunk)
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            capture.append("\n<<EOF>>\n")
            break


def screen_text() -> str:
    return "\n".join(line.rstrip() for line in screen.display)


def dump(label: str):
    snapshots[label] = screen_text()
    print(f"===== SCREEN: {label} =====")
    for i, line in enumerate(screen.display):
        line = line.rstrip()
        if line:
            print(f"{i:02d}| {line}")
    print(f"===== END: {label} =====", flush=True)


def wait_for(cond, timeout: float, label: str) -> bool:
    """cond: substring of the rendered screen, or a predicate over screen lines."""
    end = time.time() + timeout
    while time.time() < end:
        drain(1.0)
        if callable(cond):
            if cond([l.rstrip() for l in screen.display]):
                print(f"[wait_for] predicate satisfied for {label}", flush=True)
                return True
        elif cond in screen_text():
            print(f"[wait_for] found {cond!r} for {label}", flush=True)
            return True
    print(f"[wait_for] TIMEOUT for {label}", flush=True)
    return False


# 1. Boot to home screen.
drain(6)
dump("AFTER BOOT")

# 2. Type the prompt and submit.
child.send(PROMPT)
drain(1.5)
child.send("\r")

# 3. Wait for the question DIALOG itself ("1. Apples" only renders in the
#    dialog option list — the prompt text echoed in the transcript does not
#    contain that string). Model turn takes 10-30s.
got_dialog = wait_for("1. Apples", 90, "question dialog")
drain(2)
dump("QUESTION DIALOG")

# 4. Answer question 1: "1" picks Apples and auto-advances to the Notes tab.
child.send("1")
got_notes = wait_for("No note", 15, "notes tab")
drain(1)
dump("NOTES TAB")

# 5. Notes tab: "2" = Type your own answer -> opens free-text entry.
child.send("2")
drain(2)
dump("NOTE INPUT")

# 6. Type the custom note, then enter to accept it.
child.send(NOTE)
drain(1.5)
dump("NOTE TYPED")
child.send("\r")
drain(2)
dump("AFTER NOTE ENTER")

# 7. Reach the Review/Confirm tab (usually auto-advanced) and submit.
if "Review" not in screen_text():
    child.send("\t")
    drain(1.5)
    dump("AFTER TAB")
child.send("\r")
drain(2)
dump("AFTER SUBMIT")

# 8. Wait for the model's final standalone reply line "DONE" (the prompt text
#    only contains "DONE." with a period, never a bare DONE line).
got_done = wait_for(lambda lines: any(l.strip() == "DONE" for l in lines), 90, "final DONE")
drain(3)
dump("FINAL")

# 9. Quit.
try:
    child.sendcontrol("c")
    time.sleep(0.3)
    child.sendcontrol("c")
    child.close(force=True)
except Exception:
    pass

full = clean("".join(capture))
dialog = snapshots.get("QUESTION DIALOG", "")
final = snapshots.get("FINAL", "")
print("\n===== VERDICT =====")
print("DIALOG_SEEN:", got_dialog)
print("PREVIEW_BARS_ON_DIALOG:", all(f"| P{n}" in dialog.replace("│", "|") for n in range(1, 6)))
print("APPLES_RED_FRUIT_ON_DIALOG:", "1. Apples" in dialog and "Red fruit" in dialog)
print("TAB_ROW_HAS_NOTES:", "Notes" in dialog and "Confirm" in dialog)
print("NOTES_TAB_SEEN:", got_notes)
print("NO_NOTE_OPTION:", "No note" in snapshots.get("NOTES TAB", ""))
print("TYPE_YOUR_OWN:", "Type your own answer" in snapshots.get("NOTES TAB", ""))
print("DONE_SEEN:", got_done)
print("NOTE_IN_STREAM:", NOTE in full)
print("NOTE_RENDERED_TRANSCRIPT:", f"note: {NOTE}" in full)
print("NOTE_ON_FINAL_SCREEN:", NOTE in final)
print("CONNECT_ERROR:", "connect a provider" in full.lower() or "unable to connect" in full.lower())
