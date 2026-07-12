import AppKit
import Foundation

/// Locates the built web renderer and bridge shim. Packaged builds read from
/// the bundle's Resources; `swift run` development builds point at the repo's
/// `out/` directory through environment variables (see scripts/build-macos-app.sh).
struct ShellResources {
  let webRoot: URL
  let shimSource: String
  /// When set (CODEPI_DEV_URL), the shell loads the Vite dev server instead of
  /// the bundled build — mirroring the ELECTRON_RENDERER_URL flow.
  let devServerURL: URL?

  @MainActor
  static func locate() -> ShellResources {
    let environment = ProcessInfo.processInfo.environment
    let resourceRoot = Bundle.main.resourceURL

    let webRoot = environment["CODEPI_WEB_DIR"].map { URL(fileURLWithPath: $0) }
      ?? resourceRoot?.appendingPathComponent("web", isDirectory: true)
    let shimPath = environment["CODEPI_SHIM_PATH"].map { URL(fileURLWithPath: $0) }
      ?? resourceRoot?.appendingPathComponent("codepi-shim.js")
    let devServerURL = environment["CODEPI_DEV_URL"].flatMap { URL(string: $0) }

    guard
      let webRoot,
      let shimPath,
      let shimSource = try? String(contentsOf: shimPath, encoding: .utf8)
    else {
      fail("CodePi could not find its web resources. Run `npm run build:web` first, "
        + "or set CODEPI_WEB_DIR and CODEPI_SHIM_PATH for development runs.")
    }
    if devServerURL == nil && !FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) {
      fail("No renderer build found at \(webRoot.path). Run `npm run build:web` first.")
    }
    return ShellResources(webRoot: webRoot, shimSource: shimSource, devServerURL: devServerURL)
  }

  @MainActor
  private static func fail(_ message: String) -> Never {
    let alert = NSAlert()
    alert.messageText = "CodePi cannot start"
    alert.informativeText = message
    alert.runModal()
    exit(1)
  }
}
