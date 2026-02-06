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
const POLL_INTERVAL_MS = 500;
const FILE_SCAN_INTERVAL_MS = 10_000;

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

function run() {
  if (process.argv.length < 3) {
    console.log("Usage: claude-log-tail <directory>");
    process.exit(1);
  }

  const basedir = path.resolve(process.argv[2]);
  if (!fs.existsSync(basedir) || !fs.statSync(basedir).isDirectory()) {
    console.error(`Error: Directory does not exist: ${basedir}`);
    process.exit(1);
  }

  const shutdown = () => {
    process.stdout.write(`\n${C_TIME}Shutting down...${C_RESET}\n`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Monitoring JSONL files in: ${basedir}`);
  console.log(
    `Polling every ${POLL_INTERVAL_MS / 1000}s. New files checked every ${FILE_SCAN_INTERVAL_MS / 1000}s.`,
  );
  console.log("Press Ctrl+C to exit.");
  console.log("---");

  const filePositions = new Map();
  let knownFiles = findJsonlFiles(basedir);

  console.log(`Monitoring ${knownFiles.size} JSONL files`);
  console.log("---");

  for (const filepath of knownFiles) {
    try {
      filePositions.set(filepath, fs.statSync(filepath).size);
    } catch {
      filePositions.set(filepath, 0);
    }
  }

  let lastFileScan = Date.now();

  setInterval(() => {
    for (const filepath of knownFiles) {
      try {
        const currentSize = fs.statSync(filepath).size;
        const lastPos = filePositions.get(filepath) || 0;

        if (currentSize > lastPos) {
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
                console.log(formatted);
              }
            }

            filePositions.set(filepath, lastPos + bytesRead);
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        // File may have been deleted between scans.
      }
    }

    const now = Date.now();
    if (now - lastFileScan >= FILE_SCAN_INTERVAL_MS) {
      lastFileScan = now;

      const currentFiles = findJsonlFiles(basedir);
      const newFiles = [...currentFiles].filter((f) => !knownFiles.has(f)).sort();

      for (const filepath of newFiles) {
        const project = getProjectName(filepath, basedir);
        const time = new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        console.log(`${C_TIME}[${time}]${C_RESET} ${C_PROJ}[+]${C_RESET} ${project}`);

        try {
          filePositions.set(filepath, fs.statSync(filepath).size);
        } catch {
          filePositions.set(filepath, 0);
        }
      }

      for (const filepath of knownFiles) {
        if (!currentFiles.has(filepath)) {
          filePositions.delete(filepath);
        }
      }

      knownFiles = currentFiles;
    }
  }, POLL_INTERVAL_MS);
}

run();
