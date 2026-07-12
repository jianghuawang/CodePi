import Foundation
import WebKit

/// Serves the bundled renderer over codepi://app/… so the page has a stable
/// origin (the CSP's 'self') without file:// quirks. Reads are local, small,
/// and handled synchronously on the main thread, which sidesteps start/stop
/// races in the WKURLSchemeTask lifecycle.
final class WebSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "codepi"
  static let host = "app"

  private let root: URL

  init(root: URL) {
    self.root = root.standardizedFileURL
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    guard let url = urlSchemeTask.request.url else {
      urlSchemeTask.didFailWithError(Self.error("Missing request URL"))
      return
    }
    var path = url.path
    if path.isEmpty || path == "/" { path = "/index.html" }
    let fileURL = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard fileURL.path.hasPrefix(root.path + "/") || fileURL.path == root.path else {
      urlSchemeTask.didFailWithError(Self.error("Rejected path traversal"))
      return
    }
    guard let data = try? Data(contentsOf: fileURL) else {
      urlSchemeTask.didFailWithError(Self.error("Not found: \(path)"))
      return
    }
    let response = URLResponse(
      url: url,
      mimeType: Self.mimeType(for: fileURL.pathExtension),
      expectedContentLength: data.count,
      textEncodingName: nil
    )
    urlSchemeTask.didReceive(response)
    urlSchemeTask.didReceive(data)
    urlSchemeTask.didFinish()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    // Requests complete synchronously in start(_:), so there is nothing to cancel.
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "works.earendil.codepi.scheme", code: 404, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private static func mimeType(for pathExtension: String) -> String {
    switch pathExtension.lowercased() {
    case "html": return "text/html"
    case "js", "mjs": return "text/javascript"
    case "css": return "text/css"
    case "json", "map": return "application/json"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    case "ico": return "image/x-icon"
    case "woff": return "font/woff"
    case "woff2": return "font/woff2"
    case "ttf": return "font/ttf"
    case "wasm": return "application/wasm"
    case "txt": return "text/plain"
    default: return "application/octet-stream"
    }
  }
}
