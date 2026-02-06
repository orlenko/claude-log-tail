# claude-log-tail

Tail Claude JSONL conversation logs with rich terminal formatting.

This repo includes two implementations:

- `claude-log-tail.py` (Python, stdlib-only)
- `claude-log-tail.js` (Node.js, stdlib-only, npm-ready)

## Usage

### Node.js version (npm / npx)

```bash
npx claude-log-tail ~/.claude/projects
```

Or install globally:

```bash
npm install -g claude-log-tail
claude-log-tail ~/.claude/projects
```

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
- Node.js tool: no external dependencies
