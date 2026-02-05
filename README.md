# claude-log-tail

Tail Claude JSONL conversation logs with rich terminal formatting.

This repo includes a Python implementation:

- `claude-log-tail.py` (Python, stdlib-only)

## Usage

### Python version

```bash
./claude-log-tail.py <directory>
```

## What it does

- Recursively discovers `.jsonl` files under the target directory
- Follows new log lines
- Detects newly created `.jsonl` files and starts following them
- Parses Claude event JSON and prints colorized, compact output

## Dependencies

- Python tool: no external dependencies

