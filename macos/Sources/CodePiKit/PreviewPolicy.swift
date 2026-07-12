import Foundation

/// Port of `normalizePreviewUrl` from preview-service.ts: loopback-only,
/// http(s)-only, credential-free URLs for the embedded dev-server preview.
public enum PreviewPolicy {
  static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]

  public static func normalizeURL(_ value: String) throws -> URL {
    guard !value.contains("\0"), value.count <= 4_096 else { throw BridgeError("Preview URL is invalid") }
    var input = value.trimmingCharacters(in: .whitespaces)
    if input.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) == nil {
      input = "http://" + input
    }
    guard var components = URLComponents(string: input), let scheme = components.scheme?.lowercased() else {
      throw BridgeError("Preview URL is invalid")
    }
    guard scheme == "http" || scheme == "https" else { throw BridgeError("Preview only supports HTTP and HTTPS") }
    guard components.user == nil, components.password == nil else {
      throw BridgeError("Preview URLs cannot contain credentials")
    }
    let hostname = (components.host ?? "").lowercased()
    if hostname == "0.0.0.0" { components.host = "127.0.0.1" }
    else if hostname == "::" || hostname == "[::]" { components.host = "::1" }
    else if !loopbackHosts.contains(hostname) {
      throw BridgeError("Preview is limited to local development servers")
    }
    if let port = components.port, !(1...65_535).contains(port) { throw BridgeError("Preview port is invalid") }
    guard let url = components.url else { throw BridgeError("Preview URL is invalid") }
    return url
  }
}
