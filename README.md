# claude-log-tail

Tail Claude JSONL conversation logs with rich terminal formatting.

This repo includes two implementations:

- `claude-log-tail.py` (Python, stdlib-only)
- `claude-log-tail.sh` (Bash + `jq`, optional `multitail` mode)

## Usage

### Python version

```bash
./claude-log-tail.py <directory>
```

### Bash version

```bash
./claude-log-tail.sh <directory>
```

Optional multitail UI:

```bash
./claude-log-tail.sh -m <directory>
```

## What it does

- Recursively discovers `.jsonl` files under the target directory
- Follows new log lines
- Detects newly created `.jsonl` files and starts following them
- Parses Claude event JSON and prints colorized, compact output

## Dependencies

- Python tool: no external dependencies
- Bash tool: `jq`
- Optional for `-m`: `multitail`

Install bash dependencies on macOS:

```bash
brew install jq multitail
```
