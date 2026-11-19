#!/usr/bin/env bash
# 构建 Bellwood.app。两种模式（docs/mac-distribution-design.md）：
#   默认（源码开发模式）：build/Bellwood.app，Info.plist 写本机仓库与本机 Node 的路径；--install 装到 /Applications（hub self-reload 靠它）。
#   --dist（分发模式）：build/dist/Bellwood.app，随包内置官方 Node 与守护进程（Contents/Resources/runtime），
#                       内层二进制先签、整包再签，打 arm64 DMG 与 .sha256。不会装到 /Applications。
# 分发模式的签名参数（第二期 Developer ID 只需补这几个环境变量）：
#   MAC_SIGN_IDENTITY       签名身份，默认 "-"（ad-hoc，unsigned preview）；填 "Developer ID Application: …" 时自动开 hardened runtime 与时间戳
#   MAC_NODE_ENTITLEMENTS   随包 Node 的 entitlements，默认 apps/macos/node.entitlements
#   MAC_APP_ENTITLEMENTS    主程序的 entitlements，默认不用
#   MAC_NOTARY_PROFILE      notarytool 的 keychain profile；设了且身份不是 "-" 时公证并 staple DMG
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

USAGE="Usage: bash scripts/build-mac-app.sh [--build-web] [--install | --dist]"
INSTALL=0
BUILD_WEB=0
DIST=0
for arg in "$@"; do
  case "$arg" in
    --install)
      INSTALL=1
      ;;
    --build-web)
      BUILD_WEB=1
      ;;
    --dist)
      DIST=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "$USAGE" >&2
      exit 1
      ;;
  esac
done
if [[ "$DIST" -eq 1 && "$INSTALL" -eq 1 ]]; then
  echo "--dist 产出的是安装包（DMG），不装到 /Applications；去掉 --install。" >&2
  exit 1
fi

if [[ "$BUILD_WEB" -eq 1 ]]; then
  pnpm build
fi

APP_NAME="Bellwood.app"
BUILD_DIR="$REPO_DIR/build"
if [[ "$DIST" -eq 1 ]]; then
  OUT_DIR="$BUILD_DIR/dist"
  # 分发包只做 Apple 芯片（arm64），与构建机架构无关
  ARCH="arm64"
else
  OUT_DIR="$BUILD_DIR"
  ARCH="$(uname -m)"
fi
APP_DIR="$OUT_DIR/$APP_NAME"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICONSET_DIR="$OUT_DIR/AppIcon.iconset"
TMP_BUILD_DIR="$OUT_DIR/.tmp"

rm -rf "$APP_DIR" "$ICONSET_DIR" "$TMP_BUILD_DIR"
if [[ "$DIST" -eq 0 ]]; then
  rm -rf "$BUILD_DIR/Agent Hub.app" "$BUILD_DIR/Fusa.app"
fi
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$ICONSET_DIR" "$TMP_BUILD_DIR"
ORIGINAL_TMPDIR="${TMPDIR:-/tmp}"
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

/usr/bin/swiftc -O \
  -target "${ARCH}-apple-macos13.0" \
  -framework AppKit \
  -framework WebKit \
  -framework UserNotifications \
  "$REPO_DIR"/apps/macos/*.swift \
  -o "$MACOS_DIR/AgentHub"

# Info.plist：两种模式共用的键 + 各自的运行环境键（$1：版本号，$2：额外键）
write_info_plist() {
  local version="$1"
  local extra_keys="$2"
  cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Bellwood</string>
  <key>CFBundleDisplayName</key>
  <string>Bellwood</string>
  <key>CFBundleIdentifier</key>
  <string>com.agenthub.desktop</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
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
${extra_keys}
</dict>
</plist>
EOF
}

if [[ "$DIST" -eq 0 ]]; then
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

  VERSION="$("$NODE_PATH" --input-type=module -e 'import { readDesktopAppVersion } from "./scripts/stage-runtime-common.ts"; process.stdout.write(readDesktopAppVersion());')"
  write_info_plist "$VERSION" "  <key>AgentHubRepoDir</key>
  <string>${REPO_DIR}</string>
  <key>AgentHubNodePath</key>
  <string>${NODE_PATH}</string>"

  /usr/bin/codesign --force --deep -s - "$APP_DIR"
  rm -rf "$TMP_BUILD_DIR"

  if [[ "$INSTALL" -eq 1 ]]; then
    /usr/bin/ditto "$APP_DIR" "/Applications/$APP_NAME"
    echo "Installed to /Applications/$APP_NAME"
    for legacy in "Agent Hub.app" "Fusa.app"; do
      if [[ -d "/Applications/$legacy" ]]; then
        echo "提示：检测到旧版 /Applications/$legacy，可手动删除。"
      fi
    done
  else
    echo "Built $APP_DIR"
  fi
  exit 0
fi

# ---------- 分发模式 ----------
if [[ ! -f "$REPO_DIR/dist/web/index.html" ]]; then
  echo "缺少前端构建产物 dist/web（先 pnpm build，或加 --build-web）" >&2
  exit 1
fi

RUNTIME_DIR="$RESOURCES_DIR/runtime"
node "$REPO_DIR/scripts/stage-mac-runtime.ts" --out-dir "$RUNTIME_DIR"
VERSION="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$RUNTIME_DIR/runtime-manifest.json")"

write_info_plist "$VERSION" "  <key>AgentHubRuntimeMode</key>
  <string>bundled</string>"

SIGN_IDENTITY="${MAC_SIGN_IDENTITY:--}"
NODE_ENTITLEMENTS="${MAC_NODE_ENTITLEMENTS:-$REPO_DIR/apps/macos/node.entitlements}"
APP_ENTITLEMENTS="${MAC_APP_ENTITLEMENTS:-}"
SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  # Developer ID：公证要求强化运行时与安全时间戳
  SIGN_FLAGS+=(--options runtime --timestamp)
fi

# 内层二进制先签（官方 node 与原生 .node 扩展），再签整个 .app；不用 --deep（Apple 不建议用它签名）
while IFS= read -r -d '' candidate; do
  if /usr/bin/file -b "$candidate" | grep -q "Mach-O"; then
    if [[ "$candidate" == "$RUNTIME_DIR/node/bin/node" ]]; then
      /usr/bin/codesign "${SIGN_FLAGS[@]}" --entitlements "$NODE_ENTITLEMENTS" "$candidate"
    else
      /usr/bin/codesign "${SIGN_FLAGS[@]}" "$candidate"
    fi
  fi
done < <(find "$RUNTIME_DIR" -type f \( -perm -u+x -o -name "*.node" -o -name "*.dylib" \) -print0)

if [[ -n "$APP_ENTITLEMENTS" ]]; then
  /usr/bin/codesign "${SIGN_FLAGS[@]}" --entitlements "$APP_ENTITLEMENTS" "$APP_DIR"
else
  /usr/bin/codesign "${SIGN_FLAGS[@]}" "$APP_DIR"
fi
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_DIR"
rm -rf "$TMP_BUILD_DIR"
export TMPDIR="$ORIGINAL_TMPDIR"

if [[ "$SIGN_IDENTITY" == "-" ]]; then
  DMG_NAME="Bellwood_${VERSION}_arm64-unsigned-preview.dmg"
else
  DMG_NAME="Bellwood_${VERSION}_arm64.dmg"
fi
DMG_PATH="$OUT_DIR/$DMG_NAME"
DMG_STAGE="$(mktemp -d "$TMPDIR/fusa-dmg.XXXXXX")"
trap 'rm -rf "$DMG_STAGE"' EXIT
/usr/bin/ditto "$APP_DIR" "$DMG_STAGE/$APP_NAME"
ln -s /Applications "$DMG_STAGE/Applications"
rm -f "$DMG_PATH" "$DMG_PATH.sha256"
# ULMO（LZMA）压缩率最高，macOS 10.15+ 可挂载（本应用最低 13.0）
/usr/bin/hdiutil create -volname "Bellwood" -srcfolder "$DMG_STAGE" -fs HFS+ -format ULMO -ov "$DMG_PATH" >/dev/null

if [[ "$SIGN_IDENTITY" != "-" ]]; then
  /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG_PATH"
  if [[ -n "${MAC_NOTARY_PROFILE:-}" ]]; then
    /usr/bin/xcrun notarytool submit "$DMG_PATH" --keychain-profile "$MAC_NOTARY_PROFILE" --wait
    /usr/bin/xcrun stapler staple "$DMG_PATH"
  fi
fi

(cd "$OUT_DIR" && /usr/bin/shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256")
DMG_BYTES="$(/usr/bin/stat -f %z "$DMG_PATH")"
APP_KB="$(/usr/bin/du -sk "$APP_DIR" | cut -f1)"
echo "Built $APP_DIR ($((APP_KB / 1024)) MiB)"
echo "Built $DMG_PATH (${DMG_BYTES} bytes, $((DMG_BYTES / 1048576)) MiB)"
