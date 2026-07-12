import AppKit
import CodePiKit
import WebKit

/// Port of `preview-service.ts`: one sandboxed, ephemeral WKWebView overlaid
/// on the renderer at renderer-reported bounds. Loopback-only navigation,
/// popups/downloads/permissions denied, state and error events to the bridge.
@MainActor
final class PreviewController: NSObject, WKNavigationDelegate, WKUIDelegate {
  private struct Active {
    let threadId: String
    let webView: WKWebView
    var url: String
    var title: String
    var loading: Bool
  }

  private weak var hostView: NSView?
  private let emit: (JSONValue) -> Void
  private var active: Active?
  private var observations: [NSKeyValueObservation] = []

  init(hostView: NSView?, emit: @escaping (JSONValue) -> Void) {
    self.hostView = hostView
    self.emit = emit
  }

  static func normalizeURL(_ value: String) throws -> URL {
    try PreviewPolicy.normalizeURL(value)
  }

  func open(threadId: String, urlValue: String, bounds: JSONValue) throws {
    let url = try Self.normalizeURL(urlValue)
    guard let hostView else { throw BridgeError("The CodePi window is unavailable") }
    if var current = active, current.threadId == threadId {
      try setBounds(threadId: threadId, bounds: bounds)
      current.url = url.absoluteString
      current.loading = true
      active = current
      emitState()
      current.webView.load(URLRequest(url: url))
      return
    }
    close(threadId: active?.threadId)

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    hostView.addSubview(webView)
    active = Active(threadId: threadId, webView: webView, url: url.absoluteString, title: "", loading: true)
    try setBounds(threadId: threadId, bounds: bounds)
    observations = [
      webView.observe(\.title) { [weak self] view, _ in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            guard let self, self.active?.webView === view else { return }
            let title = (view.title ?? "")
              .replacingOccurrences(of: "[\r\n\0]", with: " ", options: .regularExpression)
            self.active?.title = String(title.prefix(200))
            self.emitState()
          }
        }
      },
      webView.observe(\.isLoading) { [weak self] view, _ in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            guard let self, self.active?.webView === view else { return }
            self.active?.loading = view.isLoading
            self.emitState()
          }
        }
      },
      webView.observe(\.url) { [weak self] view, _ in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            guard let self, self.active?.webView === view else { return }
            if let url = view.url?.absoluteString { self.active?.url = url }
            self.emitState()
          }
        }
      }
    ]
    emitState()
    webView.load(URLRequest(url: url))
  }

  func setBounds(threadId: String, bounds: JSONValue) throws {
    guard let active, active.threadId == threadId, let hostView else {
      throw BridgeError("Preview is not open for this thread")
    }
    guard let object = bounds.objectValue,
          let x = object["x"]?.numberValue,
          let y = object["y"]?.numberValue,
          let width = object["width"]?.numberValue,
          let height = object["height"]?.numberValue
    else { throw BridgeError("Preview bounds are invalid") }
    let contentWidth = max(1, hostView.bounds.width)
    let contentHeight = max(1, hostView.bounds.height)
    let clampedX = min(max(0, x.rounded()), Double(contentWidth) - 1)
    let clampedY = min(max(0, y.rounded()), Double(contentHeight) - 1)
    let clampedWidth = min(Double(contentWidth) - clampedX, max(1, width.rounded()))
    let clampedHeight = min(Double(contentHeight) - clampedY, max(1, height.rounded()))
    // Renderer bounds use a top-left origin; AppKit's default is bottom-left.
    let frame = NSRect(
      x: clampedX,
      y: Double(contentHeight) - clampedY - clampedHeight,
      width: clampedWidth,
      height: clampedHeight
    )
    active.webView.frame = frame
  }

  func action(threadId: String, action: String) throws {
    guard let active, active.threadId == threadId else { throw BridgeError("Preview is not open for this thread") }
    switch action {
    case "back": if active.webView.canGoBack { active.webView.goBack() }
    case "forward": if active.webView.canGoForward { active.webView.goForward() }
    case "reload": active.webView.reload()
    default: throw BridgeError("Preview action is invalid")
    }
  }

  func close(threadId: String?) {
    guard let current = active, threadId == nil || current.threadId == threadId else { return }
    observations = []
    current.webView.stopLoading()
    current.webView.removeFromSuperview()
    active = nil
  }

  private func emitState() {
    guard let active else { return }
    emit(.object([
      "type": .string("state"),
      "threadId": .string(active.threadId),
      "url": .string(active.webView.url?.absoluteString ?? active.url),
      "title": .string(active.title.isEmpty ? (active.webView.title ?? "") : active.title),
      "loading": .bool(active.loading),
      "canGoBack": .bool(active.webView.canGoBack),
      "canGoForward": .bool(active.webView.canGoForward)
    ]))
  }

  private func emitError(_ message: String) {
    guard let active else { return }
    emit(.object(["type": .string("error"), "threadId": .string(active.threadId), "message": .string(message)]))
  }

  // MARK: - WKNavigationDelegate (loopback-only, no downloads)

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard navigationAction.targetFrame?.isMainFrame != false else {
      decisionHandler(.allow)
      return
    }
    do {
      _ = try Self.normalizeURL(navigationAction.request.url?.absoluteString ?? "")
      decisionHandler(.allow)
    } catch {
      emitError((error as? BridgeError)?.message ?? "Preview navigation was blocked")
      decisionHandler(.cancel)
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    handleLoadFailure(error)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    handleLoadFailure(error)
  }

  private func handleLoadFailure(_ error: Error) {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
    active?.loading = false
    emitError("Preview failed to load: \(nsError.localizedDescription)")
    emitState()
  }

  // MARK: - WKUIDelegate (no popups, no permissions)

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    nil
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.deny)
  }
}
