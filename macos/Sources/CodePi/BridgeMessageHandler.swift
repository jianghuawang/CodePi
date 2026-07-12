import CodePiKit
import WebKit

/// Receives `window.codePi` requests from the shim and routes them through the
/// BridgeRouter. Mirrors the `trustedSender` posture of the Electron main
/// process: main frame only, app-controlled origins only.
@MainActor
final class BridgeMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
  static let name = "codepi"

  private let router: BridgeRouter

  init(router: BridgeRouter) {
    self.router = router
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping @MainActor (Any?, String?) -> Void
  ) {
    guard message.frameInfo.isMainFrame, Self.trustedOrigin(message.frameInfo.securityOrigin) else {
      replyHandler(nil, "Bridge request rejected")
      return
    }
    guard let raw = message.body as? String else {
      replyHandler(nil, "Bridge request must be a JSON string")
      return
    }
    let router = self.router
    Task { @MainActor in
      let response = await router.dispatch(raw: raw)
      replyHandler(response.body, response.error)
    }
  }

  private static func trustedOrigin(_ origin: WKSecurityOrigin) -> Bool {
    if origin.protocol == WebSchemeHandler.scheme { return true }
    // Vite dev server during development (CODEPI_DEV_URL).
    let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]
    return (origin.protocol == "http" || origin.protocol == "https") && loopbackHosts.contains(origin.host)
  }
}
