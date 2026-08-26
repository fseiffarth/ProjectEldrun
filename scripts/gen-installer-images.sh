#!/usr/bin/env bash
# Render the NSIS installer branding (Windows setup .exe) from the brand SVGs.
#
# NSIS/MUI only reads plain BMP for the header and welcome/finish sidebar, so
# the committed .bmp files are build inputs: the Windows CI runner has no SVG
# renderer. Re-run this after editing either .svg and commit the result.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/src-tauri/icons/installer"

render() { # <svg> <png> <w> <h>
  if command -v inkscape >/dev/null 2>&1; then
    inkscape "$1" --export-type=png --export-filename="$2" \
      --export-width="$3" --export-height="$4" --export-background=black \
      --export-background-opacity=1 >/dev/null 2>&1
  elif command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$3" -h "$4" -b black -o "$2" "$1"
  elif command -v magick >/dev/null 2>&1; then
    magick -background black -density 384 "$1" -resize "${3}x${4}!" "$2"
  else
    echo "need inkscape, rsvg-convert, or magick to render $1" >&2
    exit 1
  fi
}

to_bmp() { # <png> <bmp>
  local im
  im="$(command -v magick || command -v convert)" || {
    echo "need ImageMagick to write BMP" >&2
    exit 1
  }
  # MUI wants an opaque 24-bit BMP; alpha or a v5 header renders as garbage.
  "$im" "$1" -background black -alpha remove -alpha off \
    -type TrueColor -depth 8 "BMP3:$2"
}

for pair in "header 150 57" "sidebar 164 314"; do
  set -- $pair
  render "$DIR/$1.svg" "$DIR/$1.png" "$2" "$3"
  to_bmp "$DIR/$1.png" "$DIR/$1.bmp"
  rm -f "$DIR/$1.png"
  echo "wrote $DIR/$1.bmp (${2}x${3})"
done
