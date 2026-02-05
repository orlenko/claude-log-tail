#!/usr/bin/env python3
from __future__ import annotations
"""
claude-log-tail.py - Monitor Claude JSONL conversation logs with colored output

Usage: ./claude-log-tail.py <directory>

No external dependencies required - uses Python stdlib only.
"""

import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

# ANSI colors
C_RESET = '\033[0m'
C_TIME = '\033[38;5;243m'
C_PROJ = '\033[38;5;33m'
C_USER = '\033[38;5;34m'
C_ASST = '\033[38;5;208m'
C_TOOL = '\033[38;5;141m'
C_ERR = '\033[38;5;196m'
C_DEF = '\033[38;5;252m'

MAX_CONTENT_LEN = 300
POLL_INTERVAL = 0.5  # Check for changes every 0.5 seconds
FILE_SCAN_INTERVAL = 10  # Check for new files every 10 seconds


def get_project_name(filepath: str, basedir: str) -> str:
    """Extract clean project name from file path."""
    rel = os.path.relpath(filepath, basedir)
    project = rel.split(os.sep)[0]

    home = os.path.expanduser("~")
    home_prefix = home.lstrip("/").replace("/", "-") + "-"

    if project.startswith("-"):
        project = project[1:]
    if project.startswith(home_prefix):
        project = project[len(home_prefix):]

    return project


def extract_content(msg_content) -> str:
    """Extract readable content from message."""
    if isinstance(msg_content, str):
        return msg_content
    elif isinstance(msg_content, list):
        parts = []
        for item in msg_content:
            t = item.get("type", "")
            if t == "text":
                parts.append(item.get("text", ""))
            elif t == "thinking":
                parts.append("[thinking]")
            elif t == "tool_use":
                name = item.get("name", "?")
                inp = item.get("input", {})
                # Show useful snippet based on tool type
                if name == "Bash" and inp.get("command"):
                    cmd = inp["command"][:80].replace("\n", " ")
                    parts.append(f"$ {cmd}")
                elif name == "Read" and inp.get("file_path"):
                    parts.append(f"read {inp['file_path']}")
                elif name == "Edit" and inp.get("file_path"):
                    parts.append(f"edit {inp['file_path']}")
                elif name == "Write" and inp.get("file_path"):
                    parts.append(f"write {inp['file_path']}")
                elif name == "Glob" and inp.get("pattern"):
                    parts.append(f"glob {inp['pattern']}")
                elif name == "Grep" and inp.get("pattern"):
                    parts.append(f"grep {inp['pattern'][:50]}")
                elif name == "Task" and inp.get("prompt"):
                    parts.append(f"task: {inp['prompt'][:60]}")
                else:
                    parts.append(f"[{name}]")
            elif t == "tool_result":
                content = item.get("content", "")
                s = content if isinstance(content, str) else str(content)
                parts.append(s[:100])
        return " | ".join(p for p in parts if p)
    return ""


def get_effective_type(data: dict) -> str:
    """Determine effective message type."""
    msg_type = data.get("type", "")
    msg_content = data.get("message", {}).get("content")

    if msg_type == "user" and isinstance(msg_content, list):
        if any(item.get("type") == "tool_result" for item in msg_content):
            return "tool"
    return msg_type


def parse_timestamp_local(ts: str) -> str:
    """Parse ISO timestamp and return local time HH:MM:SS."""
    if not ts or "T" not in ts:
        return ""
    try:
        # Handle various ISO formats
        ts_clean = ts.replace("Z", "+00:00")
        if "." in ts_clean:
            # Truncate microseconds if too long
            parts = ts_clean.split(".")
            frac_and_tz = parts[1]
            # Find where timezone starts (+ or -)
            for i, c in enumerate(frac_and_tz):
                if c in "+-":
                    frac = frac_and_tz[:i][:6]  # max 6 digits
                    tz = frac_and_tz[i:]
                    ts_clean = f"{parts[0]}.{frac}{tz}"
                    break
            else:
                ts_clean = f"{parts[0]}.{frac_and_tz[:6]}"
        dt = datetime.fromisoformat(ts_clean)
        # Convert to local time
        local_dt = dt.astimezone()
        return local_dt.strftime("%H:%M:%S")
    except (ValueError, AttributeError):
        # Fallback: just extract time portion
        return ts.split("T")[1].split(".")[0] if "T" in ts else ""


def format_line(line: str, project: str) -> str | None:
    """Parse JSON line and format for display."""
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return None

    msg_type = get_effective_type(data)
    if msg_type in ("file-history-snapshot", "progress"):
        return None

    ts = data.get("timestamp", "")
    time_part = parse_timestamp_local(ts)

    msg = data.get("message", {})
    content = extract_content(msg.get("content", ""))
    if not content:
        return None

    content = " ".join(content.replace("\n", " ").split())
    if len(content) > MAX_CONTENT_LEN:
        content = content[:MAX_CONTENT_LEN] + "..."

    colors = {"user": C_USER, "assistant": C_ASST, "tool": C_TOOL}
    color = colors.get(msg_type, C_DEF)
    if "error" in content.lower():
        color = C_ERR

    return f"{C_TIME}[{time_part}]{C_RESET} {C_PROJ}[{project}]{C_RESET} {color}[{msg_type}]{C_RESET} {content}"


def find_jsonl_files(basedir: str) -> set:
    """Find all .jsonl files under basedir."""
    files = set()
    for root, _, filenames in os.walk(basedir):
        for fname in filenames:
            if fname.endswith(".jsonl"):
                files.add(os.path.join(root, fname))
    return files


def signal_handler(signum, frame):
    """Handle shutdown signals."""
    print(f"\n{C_TIME}Shutting down...{C_RESET}", flush=True)
    os._exit(0)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <directory>")
        sys.exit(1)

    basedir = os.path.abspath(sys.argv[1])
    if not os.path.isdir(basedir):
        print(f"Error: Directory does not exist: {basedir}", file=sys.stderr)
        sys.exit(1)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print(f"Monitoring JSONL files in: {basedir}")
    print(f"Polling every {POLL_INTERVAL}s. New files checked every {FILE_SCAN_INTERVAL}s.")
    print("Press Ctrl+C to exit.")
    print("---")

    # Track file positions: filepath -> (size, position)
    file_positions: dict[str, int] = {}

    known_files = find_jsonl_files(basedir)
    print(f"Monitoring {len(known_files)} JSONL files")
    print("---")

    # Initialize positions to end of files (don't show historical content)
    for filepath in known_files:
        try:
            file_positions[filepath] = os.path.getsize(filepath)
        except OSError:
            file_positions[filepath] = 0

    last_file_scan = time.time()

    while True:
        # Check each file for new content
        for filepath in list(known_files):
            try:
                current_size = os.path.getsize(filepath)
                last_pos = file_positions.get(filepath, 0)

                if current_size > last_pos:
                    # File has grown - read new content
                    project = get_project_name(filepath, basedir)
                    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                        f.seek(last_pos)
                        for line in f:
                            line = line.rstrip()
                            if line:
                                formatted = format_line(line, project)
                                if formatted:
                                    print(formatted, flush=True)
                        file_positions[filepath] = f.tell()

            except OSError:
                # File may have been deleted
                pass

        # Periodically check for new files
        now = time.time()
        if now - last_file_scan >= FILE_SCAN_INTERVAL:
            last_file_scan = now
            current_files = find_jsonl_files(basedir)
            new_files = current_files - known_files

            if new_files:
                for f in sorted(new_files):
                    project = get_project_name(f, basedir)
                    print(f"{C_TIME}[{time.strftime('%H:%M:%S')}]{C_RESET} {C_PROJ}[+]{C_RESET} {project}")
                    # Start at end of new file (don't show historical content)
                    try:
                        file_positions[f] = os.path.getsize(f)
                    except OSError:
                        file_positions[f] = 0

                known_files = current_files

            # Also clean up deleted files
            deleted = known_files - current_files
            for f in deleted:
                file_positions.pop(f, None)
            known_files = current_files

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
