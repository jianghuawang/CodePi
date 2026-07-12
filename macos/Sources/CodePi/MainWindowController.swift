import AppKit
import CodePiKit
import WebKit

/// The primary CodePi window: hidden-inset titlebar, repositioned traffic
/// lights, sidebar vibrancy behind a transparent web view — replicating the
/// Electron BrowserWindow chrome in `platform.ts`.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate {
  let events = EventDispatcher()

  private let webView: WKWebView
  private let bridgeHandler: BridgeMessageHandler
  private static let trafficLightOrigin = NSPoint(x: 20, y: 18)

  init(resources: ShellResources, router: BridgeRouter) {
    bridgeHandler = BridgeMessageHandler(router: router)

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
    configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.setValue(false, forKey: "drawsBackground")
    if #available(macOS 12.0, *) {
      webView.underPageBackgroundColor = .clear
    }

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "CodePi"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.minSize = NSSize(width: 760, height: 480)

    let effectView = NSVisualEffectView()
    effectView.material = .sidebar
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
    events.attach(to: webView)

    if let devURL = resources.devServerURL {
      webView.load(URLRequest(url: devURL))
    } else if let url = URL(string: "\(WebSchemeHandler.scheme)://\(WebSchemeHandler.host)/index.html") {
      webView.load(URLRequest(url: url))
    }

    window.center()
    repositionTrafficLights()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("MainWindowController is created in code")
  }

  func windowDidResize(_ notification: Notification) {
    repositionTrafficLights()
  }

  func windowDidBecomeKey(_ notification: Notification) {
    repositionTrafficLights()
  }

  /// Matches Electron's trafficLightPosition {x: 20, y: 18}; the renderer's
  /// sidebar titlebar leaves a 96px safe area for exactly this placement.
  private func repositionTrafficLights() {
    guard let window else { return }
    let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
    for kind in buttons {
      guard let button = window.standardWindowButton(kind), let container = button.superview else { continue }
      let index = CGFloat(buttons.firstIndex(of: kind) ?? 0)
      let spacing = button.frame.width + 6
      let y = container.bounds.height - Self.trafficLightOrigin.y - button.frame.height / 2
      button.setFrameOrigin(NSPoint(x: Self.trafficLightOrigin.x + index * spacing, y: y))
    }
  }
}
