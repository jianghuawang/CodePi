/// Batches renderer-bound events per channel so hot streams (text deltas,
/// terminal output) cross the bridge as arrays on a timer tick instead of one
/// `evaluateJavaScript` call per event. Order is preserved per channel, and
/// channels drain in first-seen order.
public struct EventCoalescer: Sendable {
  private var order: [String] = []
  private var pending: [String: [JSONValue]] = [:]

  public init() {}

  public var isEmpty: Bool { order.isEmpty }

  public mutating func append(channel: String, payload: JSONValue) {
    if pending[channel] == nil {
      order.append(channel)
      pending[channel] = []
    }
    pending[channel]?.append(payload)
  }

  public mutating func drain() -> [(channel: String, payloads: [JSONValue])] {
    let drained = order.compactMap { channel -> (String, [JSONValue])? in
      guard let payloads = pending[channel], !payloads.isEmpty else { return nil }
      return (channel, payloads)
    }
    order.removeAll()
    pending.removeAll()
    return drained
  }
}
