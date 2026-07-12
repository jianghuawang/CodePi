import Foundation

public struct BridgeError: LocalizedError, Sendable {
  public let message: String

  public init(_ message: String) {
    self.message = message
  }

  public var errorDescription: String? { message }
}

/// Routes decoded bridge requests to registered channel handlers. Mirrors the
/// `handle(channel, callback)` registry in the Electron main process.
@MainActor
public final class BridgeRouter {
  public typealias Handler = @MainActor ([JSONValue]) async throws -> JSONValue?

  public struct Response: Sendable {
    /// JSON text for the resolved value; nil resolves the renderer promise
    /// with `undefined`, matching `Promise<void>` methods.
    public let body: String?
    public let error: String?
  }

  private var handlers: [String: Handler] = [:]

  public init() {}

  public func register(_ channel: String, handler: @escaping Handler) {
    precondition(handlers[channel] == nil, "Duplicate bridge handler for \(channel)")
    handlers[channel] = handler
  }

  public var registeredChannels: [String] { Array(handlers.keys) }

  public func dispatch(raw: String) async -> Response {
    let request: BridgeRequest
    do {
      request = try BridgeRequest.decode(raw)
    } catch {
      return Response(body: nil, error: "Malformed bridge request")
    }
    guard let handler = handlers[request.channel] else {
      return Response(body: nil, error: "\(request.channel) is not implemented in the Swift shell yet")
    }
    do {
      let result = try await handler(request.args)
      return Response(body: result.map { $0.jsonString() }, error: nil)
    } catch let error as BridgeError {
      return Response(body: nil, error: error.message)
    } catch {
      return Response(body: nil, error: error.localizedDescription)
    }
  }
}

public struct BridgeRequest: Sendable {
  public let channel: String
  public let args: [JSONValue]

  public init(channel: String, args: [JSONValue]) {
    self.channel = channel
    self.args = args
  }

  public static func decode(_ raw: String) throws -> BridgeRequest {
    struct Envelope: Decodable {
      let channel: String
      let args: [JSONValue]?
    }
    let envelope = try JSONDecoder().decode(Envelope.self, from: Data(raw.utf8))
    guard !envelope.channel.isEmpty else { throw BridgeError("Empty bridge channel") }
    return BridgeRequest(channel: envelope.channel, args: envelope.args ?? [])
  }
}
