#!/usr/bin/env node
"use strict";

/**
 * claude-log-tail.js - Monitor Claude JSONL conversation logs with colored output
 *
 * Usage: claude-log-tail <directory>
 *
 * No external dependencies required - uses Node.js stdlib only.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const C_RESET = "\x1b[0m";
const C_TIME = "\x1b[38;5;243m";
const C_PROJ = "\x1b[38;5;33m";
const C_USER = "\x1b[38;5;34m";
const C_ASST = "\x1b[38;5;208m";
const C_TOOL = "\x1b[38;5;141m";
const C_ERR = "\x1b[38;5;196m";
const C_DEF = "\x1b[38;5;252m";

const MAX_CONTENT_LEN = 300;
const POLL_INTERVAL_MS = 5000;
const DRAIN_DELAY_MS = 50;

function getProjectName(filepath, basedir) {
  const rel = path.relative(basedir, filepath);
  let project = rel.split(path.sep)[0] || rel;

  const home = os.homedir();
  const homePrefix = home.replace(/^\/+/, "").split(path.sep).join("-") + "-";

  if (project.startsWith("-")) {
    project = project.slice(1);
  }
  if (project.startsWith(homePrefix)) {
    project = project.slice(homePrefix.length);
  }

  return project;
}

function extractContent(messageContent) {
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (!Array.isArray(messageContent)) {
    return "";
  }

  const parts = [];
  for (const item of messageContent) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const type = item.type || "";
    if (type === "text") {
      parts.push(item.text || "");
      continue;
    }

    if (type === "thinking") {
      parts.push("[thinking]");
      continue;
    }

    if (type === "tool_use") {
      const name = item.name || "?";
      const input = item.input && typeof item.input === "object" ? item.input : {};

      if (name === "Bash" && input.command) {
        const command = String(input.command).slice(0, 80).replace(/\n/g, " ");
        parts.push(`$ ${command}`);
      } else if (name === "Read" && input.file_path) {
        parts.push(`read ${input.file_path}`);
      } else if (name === "Edit" && input.file_path) {
        parts.push(`edit ${input.file_path}`);
      } else if (name === "Write" && input.file_path) {
        parts.push(`write ${input.file_path}`);
      } else if (name === "Glob" && input.pattern) {
        parts.push(`glob ${input.pattern}`);
      } else if (name === "Grep" && input.pattern) {
        parts.push(`grep ${String(input.pattern).slice(0, 50)}`);
      } else if (name === "Task" && input.prompt) {
        parts.push(`task: ${String(input.prompt).slice(0, 60)}`);
      } else {
        parts.push(`[${name}]`);
      }
      continue;
    }

    if (type === "tool_result") {
      const content = item.content;
      const text = typeof content === "string" ? content : String(content);
      parts.push(text.slice(0, 100));
    }
  }

  return parts.filter(Boolean).join(" | ");
}

function getEffectiveType(data) {
  const messageType = data.type || "";
  const messageContent = data.message && data.message.content;

  if (messageType === "user" && Array.isArray(messageContent)) {
    if (messageContent.some((item) => item && item.type === "tool_result")) {
      return "tool";
    }
  }

  return messageType;
}

function parseTimestampLocal(ts) {
  if (!ts || !ts.includes("T")) {
    return "";
  }

  try {
    let tsClean = ts.replace("Z", "+00:00");

    const dotIndex = tsClean.indexOf(".");
    if (dotIndex >= 0) {
      const base = tsClean.slice(0, dotIndex);
      const fracAndTz = tsClean.slice(dotIndex + 1);
      const tzMatch = fracAndTz.match(/[+-]/);

      if (tzMatch && tzMatch.index !== undefined) {
        const idx = tzMatch.index;
        const frac = fracAndTz.slice(0, idx).slice(0, 6);
        const tz = fracAndTz.slice(idx);
        tsClean = `${base}.${frac}${tz}`;
      } else {
        tsClean = `${base}.${fracAndTz.slice(0, 6)}`;
      }
    }

    const dt = new Date(tsClean);
    if (Number.isNaN(dt.getTime())) {
      throw new Error("Invalid date");
    }

    return dt.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    if (!ts.includes("T")) {
      return "";
    }
    return ts.split("T")[1].split(".")[0];
  }
}

function formatLine(line, project) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }

  const messageType = getEffectiveType(data);
  if (messageType === "file-history-snapshot" || messageType === "progress") {
    return null;
  }

  const timePart = parseTimestampLocal(data.timestamp || "");
  const message = data.message && typeof data.message === "object" ? data.message : {};
  let content = extractContent(message.content);
  if (!content) {
    return null;
  }

  content = content.replace(/\n/g, " ").split(/\s+/).filter(Boolean).join(" ");
  if (content.length > MAX_CONTENT_LEN) {
    content = `${content.slice(0, MAX_CONTENT_LEN)}...`;
  }

  const colors = {
    user: C_USER,
    assistant: C_ASST,
    tool: C_TOOL,
  };
  let color = colors[messageType] || C_DEF;
  if (content.toLowerCase().includes("error")) {
    color = C_ERR;
  }

  return `${C_TIME}[${timePart}]${C_RESET} ${C_PROJ}[${project}]${C_RESET} ${color}[${messageType}]${C_RESET} ${content}`;
}

function findJsonlFiles(basedir) {
  const files = new Set();
  const stack = [basedir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.add(fullPath);
      }
    }
  }

  return files;
}

function drainFile(filepath, filePositions, basedir) {
  try {
    const currentSize = fs.statSync(filepath).size;
    const lastPos = filePositions.get(filepath) || 0;

    if (currentSize <= lastPos) {
      return;
    }

    const project = getProjectName(filepath, basedir);
    const bytesToRead = currentSize - lastPos;
    const fd = fs.openSync(filepath, "r");

    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, lastPos);
      const text = buffer.toString("utf8", 0, bytesRead);

      for (const lineRaw of text.split(/\r?\n/)) {
        const line = lineRaw.trimEnd();
        if (!line) {
          continue;
        }

        const formatted = formatLine(line, project);
        if (formatted) {
          process.stdout.write(`${formatted}\n`);
        }
      }

      filePositions.set(filepath, lastPos + bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // File may have been deleted
  }
}

function run() {
  if (process.argv.length < 3) {
    process.stdout.write("Usage: claude-log-tail <directory>\n");
    process.exit(1);
  }

  const basedir = path.resolve(process.argv[2]);
  if (!fs.existsSync(basedir) || !fs.statSync(basedir).isDirectory()) {
    console.error(`Error: Directory does not exist: ${basedir}`);
    process.exit(1);
  }

  const shutdown = () => {
    if (rootWatcher) {
      rootWatcher.close();
    }
    for (const watcher of dirWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    clearInterval(pollTimer);
    process.stdout.write(`\n${C_TIME}Shutting down...${C_RESET}\n`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const filePositions = new Map();
  const dirWatchers = new Map();

  // --- Debounced drain mechanism ---
  const changedFiles = new Set();
  let drainScheduled = false;

  function scheduleDrain() {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    setTimeout(flushChanges, DRAIN_DELAY_MS);
  }

  function flushChanges() {
    drainScheduled = false;
    const paths = Array.from(changedFiles);
    changedFiles.clear();

    for (const filepath of paths) {
      if (!filePositions.has(filepath)) {
        continue;
      }
      drainFile(filepath, filePositions, basedir);
    }
  }

  // --- Per-directory watcher ---
  function watchDirectory(dirPath) {
    if (dirWatchers.has(dirPath)) {
      return;
    }

    try {
      const watcher = fs.watch(dirPath, (_eventType, filename) => {
        if (!filename) {
          return;
        }

        const fullPath = path.join(dirPath, filename);

        // Already tracked? Mark changed.
        if (filePositions.has(fullPath)) {
          changedFiles.add(fullPath);
          scheduleDrain();
          return;
        }

        // New .jsonl file?
        if (filename.endsWith(".jsonl")) {
          let stats;
          try {
            stats = fs.statSync(fullPath);
          } catch {
            return;
          }
          if (!stats.isFile()) {
            return;
          }

          filePositions.set(fullPath, 0);
          watchDirectory(path.dirname(fullPath));

          const project = getProjectName(fullPath, basedir);
          const time = new Date().toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          process.stdout.write(`${C_TIME}[${time}]${C_RESET} ${C_PROJ}[+]${C_RESET} ${project}\n`);

          changedFiles.add(fullPath);
          scheduleDrain();
        }
      });

      watcher.on("error", () => {
        dirWatchers.delete(dirPath);
        try {
          watcher.close();
        } catch {
          // ignore
        }
      });

      dirWatchers.set(dirPath, watcher);
    } catch {
      // Can't watch this directory; will rely on fallback poll
    }
  }

  // --- Recursive watcher on root for new file/directory discovery ---
  // On macOS, fs.watch({ recursive: true }) uses FSEvents — a single
  // efficient kernel subscription. We filter early: only react to .jsonl
  // filenames, skipping costly statSync on everything else.
  let rootWatcher = null;
  try {
    rootWatcher = fs.watch(basedir, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        return;
      }

      const basename = path.basename(filename);
      const fullPath = path.join(basedir, filename);

      // Already tracked? Mark changed.
      if (filePositions.has(fullPath)) {
        changedFiles.add(fullPath);
        scheduleDrain();
        return;
      }

      // Only stat .jsonl files — skip everything else.
      if (!basename.endsWith(".jsonl")) {
        return;
      }

      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch {
        return;
      }
      if (!stats.isFile()) {
        return;
      }

      // New .jsonl file discovered
      filePositions.set(fullPath, 0);
      watchDirectory(path.dirname(fullPath));

      const project = getProjectName(fullPath, basedir);
      const time = new Date().toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      process.stdout.write(`${C_TIME}[${time}]${C_RESET} ${C_PROJ}[+]${C_RESET} ${project}\n`);

      changedFiles.add(fullPath);
      scheduleDrain();
    });

    rootWatcher.on("error", () => {
      if (rootWatcher) {
        rootWatcher.close();
        rootWatcher = null;
      }
    });
  } catch {
    rootWatcher = null;
  }

  // --- Initial file discovery ---
  process.stdout.write(`Monitoring JSONL files in: ${basedir}\n`);

  const knownFiles = findJsonlFiles(basedir);
  for (const filepath of knownFiles) {
    try {
      filePositions.set(filepath, fs.statSync(filepath).size);
    } catch {
      filePositions.set(filepath, 0);
    }
    watchDirectory(path.dirname(filepath));
  }

  process.stdout.write(
    `Monitoring ${filePositions.size} JSONL files in ${dirWatchers.size} directories.\n`,
  );
  process.stdout.write("Press Ctrl+C to exit.\n");
  process.stdout.write("---\n");

  // --- Fallback poll: stat only tracked files (no full tree walk) ---
  function pollTrackedFiles() {
    for (const filepath of filePositions.keys()) {
      drainFile(filepath, filePositions, basedir);
    }
  }

  const pollTimer = setInterval(pollTrackedFiles, POLL_INTERVAL_MS);
}

run();
