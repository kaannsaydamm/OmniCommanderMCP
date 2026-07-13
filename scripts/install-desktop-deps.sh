#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew is required: https://brew.sh" >&2
      exit 1
    fi
    brew install cliclick tesseract
    echo "Grant Accessibility and Screen Recording permissions to your terminal/Node runtime in System Settings."
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update
      sudo apt-get install -y xdotool wmctrl scrot imagemagick xclip wl-clipboard tesseract-ocr python3-pyatspi at-spi2-core
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y xdotool wmctrl scrot ImageMagick xclip wl-clipboard tesseract python3-pyatspi at-spi2-core
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -S --needed xdotool wmctrl scrot imagemagick xclip wl-clipboard tesseract python-pyatspi at-spi2-core
    else
      echo "Unsupported Linux package manager. Install xdotool, wmctrl, a screenshot backend, clipboard utilities, Tesseract, and pyatspi manually." >&2
      exit 1
    fi
    echo "X11 has the broadest support. Wayland capabilities depend on the compositor and installed tools."
    ;;
  *)
    echo "This script supports macOS and Linux. Use install-desktop-deps.ps1 on Windows." >&2
    exit 1
    ;;
esac
