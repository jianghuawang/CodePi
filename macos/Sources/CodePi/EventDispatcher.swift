import CodePiKit
import WebKit

/// Delivers shell events to the renderer through `window.__codepiDispatch`,
/// coalescing on a ~16 ms tick so hot streams (deltas, terminal output) batch
/// into one JavaScript evaluation per channel per tick.
@MainActor
final class EventDispatcher {
  private weak var webView: WKWebView?
  private var coalescer = EventCoalescer()
  private var flushScheduled = false

  func attach(to webView: WKWebView) {
    self.webView = webView
  }

  func emit(channel: String, payload: JSONValue) {
    coalescer.append(channel: channel, payload: payload)
    guard !flushScheduled else { return }
    flushScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self] in
      self?.flush()
    }
  }

  private func flush() {
    flushScheduled = false
    guard let webView else {
      _ = coalescer.drain()
      return
    }
    for (channel, payloads) in coalescer.drain() {
      let channelLiteral = JSONValue.string(channel).jsonString()
      let payloadLiteral = JSONValue.string(JSONValue.array(payloads).jsonString()).jsonString()
      let script = "window.__codepiDispatch && window.__codepiDispatch(\(channelLiteral), \(payloadLiteral))"
      webView.evaluateJavaScript(script, completionHandler: nil)
    }
  }
}
