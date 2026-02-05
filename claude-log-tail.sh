#!/usr/bin/env bash
#
# claude-log-tail.sh - Monitor Claude JSONL conversation logs with colored output
#
# Usage: ./claude-log-tail.sh <directory>
#
# Requirements: jq (install via: brew install jq)
#

set -euo pipefail

# Colors for iTerm2/terminal
readonly COLOR_RESET='\033[0m'
readonly COLOR_TIMESTAMP='\033[38;5;243m'  # Gray
readonly COLOR_PROJECT='\033[38;5;33m'     # Blue
readonly COLOR_USER='\033[38;5;34m'        # Green
readonly COLOR_ASSISTANT='\033[38;5;208m'  # Orange
readonly COLOR_TOOL='\033[38;5;141m'       # Purple
readonly COLOR_PROGRESS='\033[38;5;245m'   # Dim gray
readonly COLOR_ERROR='\033[38;5;196m'      # Red
readonly COLOR_DEFAULT='\033[38;5;252m'    # Light gray

MAX_CONTENT_LEN=300
USE_MULTITAIL=false

usage() {
    echo "Usage: $0 [-m] <directory>"
    echo ""
    echo "Monitor Claude JSONL conversation logs with colored output."
    echo ""
    echo "Options:"
    echo "  -m           Use multitail interface (split-screen, scrollable)"
    echo ""
    echo "Arguments:"
    echo "  directory    Path to directory containing project subdirectories with .jsonl files"
    echo ""
    echo "Example:"
    echo "  $0 ~/.claude/projects"
    echo "  $0 -m ~/.claude/projects"
    exit 1
}

check_dependencies() {
    local missing=()
    command -v jq >/dev/null 2>&1 || missing+=("jq")
    if [[ "$USE_MULTITAIL" == "true" ]]; then
        command -v multitail >/dev/null 2>&1 || missing+=("multitail")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "Error: Missing dependencies: ${missing[*]}" >&2
        echo "Install with: brew install ${missing[*]}" >&2
        exit 1
    fi
}

# Extract project name from file path (immediate subdirectory of base dir)
# Also strips common home directory prefix for cleaner display
get_project_name() {
    local filepath="$1"
    local basedir="$2"

    # Remove base directory prefix and get first path component
    local relative="${filepath#$basedir/}"
    local project="${relative%%/*}"

    # The project name is typically like "-Users-vorlenko-code-ops"
    # Strip the home directory prefix (converted to dashes)
    # HOME=/Users/vorlenko -> Users-vorlenko-
    local home_prefix
    home_prefix="${HOME#/}"         # /Users/vorlenko -> Users/vorlenko
    home_prefix="${home_prefix//\//-}-"  # Users/vorlenko -> Users-vorlenko-

    # Remove the leading dash and home prefix if present
    project="${project#-}"  # Remove leading dash: -Users-vorlenko-code -> Users-vorlenko-code
    if [[ "$project" == "$home_prefix"* ]]; then
        project="${project#$home_prefix}"  # Users-vorlenko-code -> code
    fi

    echo "$project"
}

# Format a single JSON line
format_line() {
    local line="$1"
    local project="$2"

    # Skip empty lines
    [[ -z "$line" ]] && return

    # Parse JSON with jq
    local parsed
    parsed=$(echo "$line" | jq -r '
        def truncate(n): if length > n then .[:n] + "..." else . end;

        # Detect effective type (tool_result messages come as type=user but contain tool_result)
        def effective_type:
            if .type == "user" and (.message.content | type) == "array" then
                if (.message.content | map(select(.type == "tool_result")) | length) > 0 then "tool"
                else .type
                end
            else .type
            end;

        def extract_content:
            if .message.content then
                if (.message.content | type) == "string" then
                    .message.content
                elif (.message.content | type) == "array" then
                    [.message.content[] |
                        if .type == "text" then .text
                        elif .type == "thinking" then "[thinking] " + (.thinking // "" | truncate(100))
                        elif .type == "tool_use" then "[" + .name + "] " + (.input | tostring | truncate(80))
                        elif .type == "tool_result" then ((.content // "") | if type == "string" then . else tostring end | gsub("[\\n\\r\\t]"; " ") | truncate(150))
                        else (.type // "unknown")
                        end
                    ] | join(" | ")
                else
                    ""
                end
            elif .snapshot then
                "[snapshot] " + (.snapshot.messageId // "")
            elif .data then
                (.data.type // "") + " " + (.data.hookName // "")
            else
                ""
            end;

        {
            timestamp: (.timestamp // .message.timestamp // ""),
            type: effective_type,
            content: extract_content
        } | "\(.timestamp)\t\(.type)\t\(.content)"
    ' 2>/dev/null) || return

    # Skip if parsing failed or empty
    [[ -z "$parsed" ]] && return

    local timestamp type content
    IFS=$'\t' read -r timestamp type content <<< "$parsed"

    # Skip certain types
    [[ "$type" == "file-history-snapshot" ]] && return
    [[ "$type" == "progress" ]] && return
    [[ -z "$content" ]] && return

    # Format timestamp (extract time portion)
    local time_short=""
    if [[ -n "$timestamp" ]]; then
        time_short=$(echo "$timestamp" | sed -E 's/.*T([0-9]{2}:[0-9]{2}:[0-9]{2}).*/\1/')
    fi

    # Truncate content
    if [[ ${#content} -gt $MAX_CONTENT_LEN ]]; then
        content="${content:0:$MAX_CONTENT_LEN}..."
    fi

    # Clean up content (remove newlines, excess whitespace)
    content=$(echo "$content" | tr '\n' ' ' | sed 's/  */ /g')

    # Select color based on type
    local color
    case "$type" in
        user)      color="$COLOR_USER" ;;
        assistant) color="$COLOR_ASSISTANT" ;;
        tool)      color="$COLOR_TOOL" ;;
        progress)  color="$COLOR_PROGRESS" ;;
        *)         color="$COLOR_DEFAULT" ;;
    esac

    # Check for errors in content
    if [[ "$content" == *"error"* ]] || [[ "$content" == *"Error"* ]]; then
        color="$COLOR_ERROR"
    fi

    # Output formatted line
    printf "${COLOR_TIMESTAMP}[%s]${COLOR_RESET} ${COLOR_PROJECT}[%s]${COLOR_RESET} ${color}[%s]${COLOR_RESET} %s\n" \
        "$time_short" "$project" "$type" "$content"
}

# Process input from stdin (used with multitail -l)
process_stream() {
    local basedir="$1"

    while IFS= read -r line; do
        # multitail -l gives us raw lines, we need to determine project from context
        # Since we're using -l with a command, we process each line directly
        format_line "$line" "stream"
    done
}

# State
TAILED_FILES_LIST=""
TAIL_PID_FILE=""

# Clean up on exit
cleanup() {
    echo ""
    echo "Shutting down..."

    # Kill tracked tail pipeline
    if [[ -f "$TAIL_PID_FILE" ]]; then
        local pid
        pid=$(<"$TAIL_PID_FILE")
        if [[ -n "$pid" ]]; then
            # Kill the pipeline and its children
            pkill -P "$pid" 2>/dev/null
            kill "$pid" 2>/dev/null
        fi
    fi

    rm -f "$TAILED_FILES_LIST" "$TAIL_PID_FILE" 2>/dev/null
}

# Main monitoring function - simple foreground tail with periodic restart for new files
monitor_directory() {
    local basedir="$1"
    basedir="${basedir%/}"

    TAILED_FILES_LIST=$(mktemp)
    TAIL_PID_FILE=$(mktemp)
    trap cleanup INT TERM EXIT

    echo "Monitoring JSONL files in: $basedir"
    echo "New files checked every 10s. Press Ctrl+C to exit."
    echo "---"

    # Find initial files (silent)
    find "$basedir" -name "*.jsonl" -type f -print0 2>/dev/null | while IFS= read -r -d '' file; do
        echo "$file"
    done > "$TAILED_FILES_LIST"

    local file_count
    file_count=$(wc -l < "$TAILED_FILES_LIST")
    echo "Monitoring $file_count JSONL files"
    echo "---"

    local current_project="unknown"

    # Main loop: run tail, periodically check for new files
    while true; do
        # Build file array
        local files=()
        while IFS= read -r file; do
            [[ -f "$file" ]] && files+=("$file")
        done < "$TAILED_FILES_LIST"

        [[ ${#files[@]} -eq 0 ]] && { sleep 5; continue; }

        # Run tail in background
        (
            exec tail -F -n 0 "${files[@]}" 2>/dev/null
        ) | while IFS= read -r line; do
            if [[ "$line" =~ ^==\>\ (.*)\ \<==$ ]]; then
                current_file="${BASH_REMATCH[1]}"
                current_project=$(get_project_name "$current_file" "$basedir")
                continue
            fi
            [[ -z "$line" ]] && continue
            format_line "$line" "${current_project:-unknown}"
        done &
        local pipeline_pid=$!
        echo "$pipeline_pid" > "$TAIL_PID_FILE"

        # Wait 10 seconds, then kill to check for new files
        sleep 10

        # Kill the pipeline (the while loop) and its children (the tail subshell)
        pkill -P "$pipeline_pid" 2>/dev/null
        kill "$pipeline_pid" 2>/dev/null
        wait "$pipeline_pid" 2>/dev/null

        # Check for new files
        local new_files=0
        while IFS= read -r -d '' file; do
            if ! grep -qxF "$file" "$TAILED_FILES_LIST" 2>/dev/null; then
                echo "$file" >> "$TAILED_FILES_LIST"
                local project
                project=$(get_project_name "$file" "$basedir")
                printf "${COLOR_TIMESTAMP}[%s]${COLOR_RESET} ${COLOR_PROJECT}[+]${COLOR_RESET} %s\n" "$(date +%H:%M:%S)" "$project"
                ((new_files++))
            fi
        done < <(find "$basedir" -name "*.jsonl" -type f -print0 2>/dev/null)
    done
}

# Use multitail for monitoring with scrollback and search features
monitor_with_multitail() {
    local basedir="$1"
    basedir="${basedir%/}"

    # Find all jsonl files first
    local files=()
    while IFS= read -r -d '' file; do
        files+=("$file")
    done < <(find "$basedir" -name "*.jsonl" -type f -print0 2>/dev/null)

    if [[ ${#files[@]} -eq 0 ]]; then
        echo "No .jsonl files found in $basedir" >&2
        exit 1
    fi

    # Create temp files for processor script and file list
    local processor filelist
    processor=$(mktemp)
    filelist=$(mktemp)
    chmod +x "$processor"
    printf '%s\n' "${files[@]}" > "$filelist"
    trap "rm -f '$processor' '$filelist'" EXIT

    # Write the processor script
    cat > "$processor" << 'PROCSCRIPT'
#!/usr/bin/env bash
basedir="$1"
filelist="$2"

# Read files from list
mapfile -t files < "$filelist"

# Colors
C_RESET=$'\033[0m'
C_TIME=$'\033[38;5;243m'
C_PROJ=$'\033[38;5;33m'
C_USER=$'\033[38;5;34m'
C_ASST=$'\033[38;5;208m'
C_TOOL=$'\033[38;5;141m'
C_DEF=$'\033[38;5;252m'
C_ERR=$'\033[38;5;196m'

# Track current file for project name
current_project="unknown"

tail -F -n 0 "${files[@]}" 2>/dev/null | while IFS= read -r line; do
    # Detect file header from tail
    if [[ "$line" =~ ^==\>\ (.*)\ \<==$ ]]; then
        filepath="${BASH_REMATCH[1]}"
        relative="${filepath#$basedir/}"
        current_project="${relative%%/*}"
        continue
    fi

    [[ -z "$line" ]] && continue

    # Parse JSON
    parsed=$(echo "$line" | jq -r '
        def truncate(n): if length > n then .[:n] + "..." else . end;
        def get_time: (.timestamp // "") | split("T") | if length > 1 then .[1] | split(".") | .[0] else "" end;

        def effective_type:
            if .type == "user" and (.message.content | type) == "array" then
                if (.message.content | map(select(.type == "tool_result")) | length) > 0 then "tool"
                else .type
                end
            else .type
            end;

        def get_content:
            if .message.content then
                if (.message.content | type) == "string" then .message.content
                elif (.message.content | type) == "array" then
                    [.message.content[] |
                        if .type == "text" then .text
                        elif .type == "thinking" then "[thinking]"
                        elif .type == "tool_use" then "[" + .name + "]"
                        elif .type == "tool_result" then ((.content // "") | if type == "string" then . else tostring end | gsub("[\\n\\r\\t]"; " ") | truncate(100))
                        else ""
                        end
                    ] | map(select(. != "")) | join(" | ")
                else ""
                end
            else ""
            end;

        effective_type as $type |
        if $type == "file-history-snapshot" or $type == "progress" then empty
        else
            get_content as $content |
            if $content == "" then empty
            else "\(get_time)\t\($type)\t\($content | gsub("\n"; " ") | truncate(300))"
            end
        end
    ' 2>/dev/null) || continue

    [[ -z "$parsed" ]] && continue

    IFS=$'\t' read -r time_str type_str content_str <<< "$parsed"

    # Select color
    case "$type_str" in
        user)      color="$C_USER" ;;
        assistant) color="$C_ASST" ;;
        tool)      color="$C_TOOL" ;;
        *)         color="$C_DEF" ;;
    esac

    [[ "$content_str" == *[Ee]rror* ]] && color="$C_ERR"

    printf '%s[%s]%s %s[%s]%s %s[%s]%s %s\n' \
        "$C_TIME" "$time_str" "$C_RESET" \
        "$C_PROJ" "$current_project" "$C_RESET" \
        "$color" "$type_str" "$C_RESET" \
        "$content_str"
done
PROCSCRIPT

    echo "Monitoring ${#files[@]} files with multitail (press q to quit, / to search)..."

    # Use multitail with the processor
    multitail -cT ANSI -n 200 -b 0 -l "$processor '$basedir' '$filelist'"
}

main() {
    # Parse options
    while getopts "mh" opt; do
        case $opt in
            m) USE_MULTITAIL=true ;;
            h) usage ;;
            *) usage ;;
        esac
    done
    shift $((OPTIND - 1))

    [[ $# -lt 1 ]] && usage

    local directory="$1"

    if [[ ! -d "$directory" ]]; then
        echo "Error: Directory does not exist: $directory" >&2
        exit 1
    fi

    check_dependencies

    if [[ "$USE_MULTITAIL" == "true" ]]; then
        monitor_with_multitail "$directory"
    else
        monitor_directory "$directory"
    fi
}

main "$@"
