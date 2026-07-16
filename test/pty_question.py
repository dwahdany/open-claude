# /// script
# requires-python = ">=3.10"
# dependencies = ["pexpect", "pyte"]
# ///
"""Drive the stock opencode TUI against the shim in a PTY and verify the v2
AskUserQuestion bridge:

  1. Previews render as a synthetic TRANSCRIPT markdown part (fenced block with the
     option label as a bold title) ABOVE the dialog, plus the `answer // note` hint.
     The dialog itself is the stock compact one: "1. Apples / Red fruit", no
     quote-barred preview lines, no synthetic Notes tab, no tab row at all for a
     single question.
  2. Note round-trip: "Type your own answer" -> "Apples // pty-note-4417" -> enter
     submits the whole dialog IMMEDIATELY (single question, no Confirm tab); the
     folded tool part shows "note: pty-note-4417" and the model replies DONE.
  3. Fast path: a plain single question submits instantly on a digit keypress.
  4. Hydration: relaunch the TUI with --continue and confirm the preview block
     still renders in the replayed transcript.
"""
import os
import re
import sys
import time

import pexpect
import pyte

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4127"
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "/tmp/oc-pty-question2"
PROMPT = (
    'Call the AskUserQuestion tool ONCE with exactly one question: '
    'question "Which fruit should I buy?", header "Fruit", multiSelect false, '
    'and two options: (1) label "Apples", description "Red fruit", preview field '
    'of exactly 5 lines "P1".."P5" each on its own line; '
    '(2) label "Bananas", description "Yellow fruit", no preview. '
    'After the tool result arrives, reply with the single word DONE.'
)
PROMPT2 = (
    'Call the AskUserQuestion tool ONCE with exactly one question: '
    'question "Pick a color", header "Color", multiSelect false, two options: '
    'label "Red" description "Warm", label "Blue" description "Cool", no previews. '
    'After the tool result arrives, reply with the single word DONE2.'
)
NOTE = "pty-note-4417"

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07")


def clean(buf: str) -> str:
    buf = ANSI.sub("", buf)
    return "".join(ch for ch in buf if ch == "\n" or ch >= " ")


env = dict(os.environ, TERM="xterm-256color", COLUMNS="120", LINES="40")
capture: list[str] = []
snapshots: dict[str, str] = {}
child: pexpect.spawn | None = None
screen = pyte.Screen(120, 40)
stream = pyte.Stream(screen)


def spawn(extra: list[str] = []):
    global child, screen, stream
    screen = pyte.Screen(120, 40)
    stream = pyte.Stream(screen)
    child = pexpect.spawn(
        "opencode",
        ["attach", URL, "--dir", DIRECTORY, "--log-level", "ERROR", *extra],
        env=env,
        dimensions=(40, 120),
        encoding="utf-8",
        timeout=120,
    )


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


def lines() -> list[str]:
    return [l.rstrip() for l in screen.display]


def screen_text() -> str:
    return "\n".join(lines())


def dump(label: str):
    snapshots[label] = screen_text()
    print(f"===== SCREEN: {label} =====")
    for i, line in enumerate(lines()):
        if line:
            print(f"{i:02d}| {line}")
    print(f"===== END: {label} =====", flush=True)


def wait_for(cond, timeout: float, label: str) -> bool:
    """cond: substring of the rendered screen, or a predicate over screen lines."""
    end = time.time() + timeout
    while time.time() < end:
        drain(1.0)
        if callable(cond):
            if cond(lines()):
                print(f"[wait_for] predicate satisfied for {label}", flush=True)
                return True
        elif cond in screen_text():
            print(f"[wait_for] found {cond!r} for {label}", flush=True)
            return True
    print(f"[wait_for] TIMEOUT for {label}", flush=True)
    return False


def quit_tui():
    try:
        child.sendcontrol("c")
        time.sleep(0.4)
        child.sendcontrol("c")
        child.close(force=True)
    except Exception:
        pass


def preview_rows(ls: list[str]) -> dict[int, int]:
    """Map n -> row index for rows that are exactly 'Pn' (fenced preview lines)."""
    out: dict[int, int] = {}
    for i, l in enumerate(ls):
        m = re.fullmatch(r"\s*P([1-5])\s*", l)
        if m:
            out[int(m.group(1))] = i
    return out


def find_row(ls: list[str], needle: str) -> int:
    for i, l in enumerate(ls):
        if needle in l:
            return i
    return -1


# ---------------- Turn 1: preview in transcript + compact dialog + note round-trip
spawn()
drain(6)
dump("AFTER BOOT")

child.send(PROMPT)
drain(1.5)
child.send("\r")

# "1. Apples" only renders in the dialog option list. Model turn takes 10-30s.
got_dialog = wait_for("1. Apples", 120, "question dialog")
drain(2)
dump("QUESTION DIALOG")
dlg_lines = lines()

# Transcript-vs-dialog geometry: the dialog starts at its "1. Apples" row; every
# preview line (exactly "Pn") and the note hint must sit ABOVE it.
dlg_row = find_row(dlg_lines, "1. Apples")
prevs = preview_rows(dlg_lines)
preview_in_transcript = (
    dlg_row >= 0
    and sorted(prevs) == [1, 2, 3, 4, 5]
    and all(prevs[n] < dlg_row for n in prevs)
    and prevs[1] < prevs[2] < prevs[3] < prevs[4] < prevs[5]
)
apples_title_row = find_row(dlg_lines[: max(dlg_row, 0)], "Apples")  # bold title above dialog
hint_row = find_row(dlg_lines, "answer // note")
hint_in_transcript = 0 <= hint_row < dlg_row if dlg_row >= 0 else False
dialog_region = "\n".join(dlg_lines[dlg_row:]) if dlg_row >= 0 else ""
dialog_compact = (
    dlg_row >= 0
    and "Red fruit" in dialog_region
    and "2. Bananas" in dialog_region
    and "3. Type your own answer" in dialog_region
    and not preview_rows(dlg_lines[dlg_row:])  # no preview lines inside the dialog
    and "│ P" not in dialog_region.replace("|", "│")  # no quote-barred previews
)
no_tabs = "Notes" not in screen_text() and "Confirm" not in screen_text()

# Note round-trip: "3" = Type your own answer -> textarea; type "Apples // <note>";
# enter submits the edit AND (single question) the whole dialog immediately.
child.send("3")
drain(1.5)
dump("NOTE INPUT")
child.send(f"Apples // {NOTE}")
drain(1.5)
dump("NOTE TYPED")
note_typed = NOTE in screen_text()
child.send("\r")
drain(2.5)
dump("AFTER ENTER")
# Immediate submit: the dialog must be gone without any further keypress.
submitted_immediately = "Type your own answer" not in screen_text() and "Confirm" not in screen_text()

got_done = wait_for(lambda ls: any(l.strip() == "DONE" for l in ls), 120, "final DONE")
drain(3)
dump("FINAL TURN 1")
final1 = snapshots["FINAL TURN 1"]
note_folded = f"note: {NOTE}" in final1
answer_folded = f"Apples, note: {NOTE}" in final1

# ---------------- Turn 2: fast path — plain question, digit press submits instantly
child.send(PROMPT2)
drain(1.5)
child.send("\r")
got_dialog2 = wait_for("1. Red", 120, "fast-path dialog")
drain(1.5)
dump("FAST DIALOG")
fast_no_tabs = "Notes" not in screen_text() and "Confirm" not in screen_text()
child.send("1")
drain(2.0)
dump("AFTER FAST PICK")
fast_submitted = "Type your own answer" not in screen_text()
got_done2 = wait_for(lambda ls: any(l.strip() == "DONE2" for l in ls), 120, "final DONE2")
drain(2)
dump("FINAL TURN 2")

# ---------------- Hydration: fresh TUI, --continue replays the transcript
quit_tui()
time.sleep(1.0)
spawn(["--continue"])
drain(10)
dump("HYDRATED")
hyd = preview_rows(lines())
attempts = 0
while sorted(hyd) != [1, 2, 3, 4, 5] and attempts < 8:
    child.send("\x1b[5~")  # PageUp: preview may be scrolled off the 40-row viewport
    drain(1.2)
    hyd = preview_rows(lines())
    attempts += 1
dump("HYDRATED SCROLLED")
hydrated_preview = sorted(hyd) == [1, 2, 3, 4, 5]
hydrated_note = f"note: {NOTE}" in screen_text() or f"note: {NOTE}" in snapshots["HYDRATED"]

quit_tui()

full = clean("".join(capture))
print("\n===== VERDICT =====")
print("DIALOG_SEEN:", got_dialog)
print("PREVIEW_IN_TRANSCRIPT_ABOVE_DIALOG:", preview_in_transcript)
print("APPLES_TITLE_ABOVE_DIALOG:", apples_title_row >= 0)
print("NOTE_HINT_IN_TRANSCRIPT:", hint_in_transcript)
print("DIALOG_COMPACT_NO_PREVIEW_LINES:", dialog_compact)
print("NO_NOTES_OR_CONFIRM_TAB:", no_tabs)
print("NOTE_TYPED_IN_TEXTAREA:", note_typed)
print("SUBMITTED_IMMEDIATELY_ON_ENTER:", submitted_immediately)
print("DONE_SEEN:", got_done)
print("NOTE_FOLDED_ON_SCREEN:", note_folded)
print("ANSWER_FOLD_EXACT:", answer_folded)
print("NOTE_IN_STREAM:", f"note: {NOTE}" in full)
print("FAST_DIALOG_SEEN:", got_dialog2)
print("FAST_NO_TABS:", fast_no_tabs)
print("FAST_SUBMITTED_INSTANTLY:", fast_submitted)
print("DONE2_SEEN:", got_done2)
print("HYDRATED_PREVIEW_P1_P5:", hydrated_preview)
print("HYDRATED_NOTE_VISIBLE:", hydrated_note)
print("CONNECT_ERROR:", "connect a provider" in full.lower() or "unable to connect" in full.lower())
