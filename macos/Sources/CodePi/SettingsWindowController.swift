import AppKit
import CodePiKit
import WebKit

/// Compact frameless settings window hosting the same web bundle at
/// `?window=settings`, with its own router restricted to settings channels.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
  private let webView: WKWebView
  private let bridgeHandler: BridgeMessageHandler
  let events: EventDispatcher

  init(resources: ShellResources, router: BridgeRouter) {
    bridgeHandler = BridgeMessageHandler(router: router)
    let dispatcher = EventDispatcher()
    events = dispatcher

    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(WebSchemeHandler(root: resources.webRoot), forURLScheme: WebSchemeHandler.scheme)
    configuration.userContentController.addUserScript(WKUserScript(
      source: resources.shimSource,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true,
      in: .page
    ))
    configuration.userContentController.addScriptMessageHandler(
      bridgeHandler,
      contentWorld: .page,
      name: BridgeMessageHandler.name
    )
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.setValue(false, forKey: "drawsBackground")

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "CodePi Settings"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true

    let effectView = NSVisualEffectView()
    effectView.material = .underWindowBackground
    effectView.blendingMode = .behindWindow
    effectView.state = .active
    effectView.frame = window.contentLayoutRect
    effectView.autoresizingMask = [.width, .height]
    webView.frame = effectView.bounds
    webView.autoresizingMask = [.width, .height]
    effectView.addSubview(webView)
    window.contentView = effectView

    super.init(window: window)
    window.delegate = self
    dispatcher.attach(to: webView)

    if let devURL = resources.devServerURL {
      var components = URLComponents(url: devURL, resolvingAgainstBaseURL: false)
      let existing = components?.queryItems ?? []
      components?.queryItems = existing + [URLQueryItem(name: "window", value: "settings")]
      if let url = components?.url { webView.load(URLRequest(url: url)) }
    } else if let url = URL(string: "\(WebSchemeHandler.scheme)://\(WebSchemeHandler.host)/index.html?window=settings") {
      webView.load(URLRequest(url: url))
    }
    window.center()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("SettingsWindowController is created in code")
  }
}
