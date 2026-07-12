#!/usr/bin/env bash
# Builds the Swift-shell CodePi.app (docs/SWIFT_SHELL_DESIGN.md §9).
#
# Development builds use the works.earendil.codepi.dev bundle id so they never
# share LaunchServices identity (or, once Phase 1 lands, state) with the
# shipping Electron app. Pass --skip-web to reuse an existing out/web build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/macos/build/CodePi.app"
CONFIGURATION="${CONFIGURATION:-release}"

if [[ "${1:-}" != "--skip-web" ]]; then
  (cd "$ROOT" && npm run build:web)
fi

(cd "$ROOT/macos" && swift build -c "$CONFIGURATION")
BINARY="$ROOT/macos/.build/$CONFIGURATION/CodePi"

# Convert the shared 1024px app icon into an .icns (cached until the source changes).
ICNS="$ROOT/macos/.build/AppIcon.icns"
if [[ ! -f "$ICNS" || "$ROOT/build/icon.png" -nt "$ICNS" ]]; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ROOT/build/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$ROOT/build/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ICNS"
  rm -rf "$(dirname "$ICONSET")"
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$BINARY" "$APP_DIR/Contents/MacOS/CodePi"
cp -R "$ROOT/out/web" "$APP_DIR/Contents/Resources/web"
cp "$ROOT/out/bridge/codepi-shim.js" "$APP_DIR/Contents/Resources/codepi-shim.js"
cp "$ICNS" "$APP_DIR/Contents/Resources/AppIcon.icns"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>works.earendil.codepi.dev</string>
  <key>CFBundleName</key>
  <string>CodePi</string>
  <key>CFBundleDisplayName</key>
  <string>CodePi Dev</string>
  <key>CFBundleExecutable</key>
  <string>CodePi</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleShortVersionString</key>
  <string>0.3.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP_DIR" >/dev/null 2>&1 || true
echo "Built $APP_DIR"
