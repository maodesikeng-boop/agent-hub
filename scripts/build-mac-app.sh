#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

INSTALL=0
BUILD_WEB=0
for arg in "$@"; do
  case "$arg" in
    --install)
      INSTALL=1
      ;;
    --build-web)
      BUILD_WEB=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: bash scripts/build-mac-app.sh [--build-web] [--install]" >&2
      exit 1
      ;;
  esac
done

if [[ "$BUILD_WEB" -eq 1 ]]; then
  pnpm build
fi

APP_NAME="Fusa.app"
BUILD_DIR="$REPO_DIR/build"
APP_DIR="$BUILD_DIR/$APP_NAME"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICONSET_DIR="$BUILD_DIR/AppIcon.iconset"
TMP_BUILD_DIR="$BUILD_DIR/.tmp"

rm -rf "$APP_DIR" "$BUILD_DIR/Agent Hub.app" "$ICONSET_DIR" "$TMP_BUILD_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$ICONSET_DIR" "$TMP_BUILD_DIR"
export TMPDIR="$TMP_BUILD_DIR"

SOURCE_ICON="$REPO_DIR/src/web/public/icons/icon-512.png"
if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Missing source icon: $SOURCE_ICON" >&2
  exit 1
fi

CONTRACT_JSON="$REPO_DIR/apps/desktop/contract.json"
if [[ ! -f "$CONTRACT_JSON" ]]; then
  echo "Missing desktop contract: $CONTRACT_JSON" >&2
  exit 1
fi
cp "$CONTRACT_JSON" "$RESOURCES_DIR/contract.json"

for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$SOURCE_ICON" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  /usr/bin/sips -z "$double" "$double" "$SOURCE_ICON" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns"
rm -rf "$ICONSET_DIR"

ARCH="$(uname -m)"
/usr/bin/swiftc -O \
  -target "${ARCH}-apple-macos13.0" \
  -framework AppKit \
  -framework WebKit \
  -framework UserNotifications \
  "$REPO_DIR"/apps/macos/*.swift \
  -o "$MACOS_DIR/AgentHub"

NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" ]]; then
  for candidate in \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.local/share/mise/installs/node/24/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if [[ -x "$candidate" ]]; then
      NODE_PATH="$candidate"
      break
    fi
  done
fi

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Fusa</string>
  <key>CFBundleDisplayName</key>
  <string>Fusa</string>
  <key>CFBundleIdentifier</key>
  <string>com.agenthub.desktop</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>AgentHub</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>AgentHubRepoDir</key>
  <string>${REPO_DIR}</string>
  <key>AgentHubNodePath</key>
  <string>${NODE_PATH}</string>
</dict>
</plist>
EOF

/usr/bin/codesign --force --deep -s - "$APP_DIR"
rm -rf "$TMP_BUILD_DIR"

if [[ "$INSTALL" -eq 1 ]]; then
  /usr/bin/ditto "$APP_DIR" "/Applications/$APP_NAME"
  echo "Installed to /Applications/$APP_NAME"
  if [[ -d "/Applications/Agent Hub.app" ]]; then
    echo "提示：检测到旧版 /Applications/Agent Hub.app，可手动删除。"
  fi
else
  echo "Built $APP_DIR"
fi
