#!/bin/bash
set -euo pipefail
SRC="/home/koushik/Downloads/Eyes Wide Shut 1999 Criterion 1080p BluRay HEVC x265 5.1 BONE.mkv"
OUT_DIR="/home/koushik/scene-browser/media"
PARTIAL="$OUT_DIR/eyes-wide-shut-browser.partial.mp4"
FINAL="$OUT_DIR/eyes-wide-shut-browser.mp4"
LOG="/home/koushik/scene-browser/logs/transcode.log"
mkdir -p "$OUT_DIR" "$(dirname "$LOG")"
rm -f "$PARTIAL" "$FINAL"
echo "START $(date -Is)" >"$LOG"
nice -n 15 ionice -c3 ffmpeg -hide_banner -y -i "$SRC" \
  -map 0:v:0 -map 0:a:0? \
  -vf "scale=-2:720" \
  -c:v libx264 -preset medium -crf 24 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ac 2 \
  -movflags +faststart \
  "$PARTIAL" >>"$LOG" 2>&1
mv -f "$PARTIAL" "$FINAL"
echo "DONE $(date -Is) size=$(stat -c%s "$FINAL")" >>"$LOG"
