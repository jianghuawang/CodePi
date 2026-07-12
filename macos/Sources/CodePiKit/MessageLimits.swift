import Foundation

/// Port of the renderer-payload bounding helpers in `pi-rpc.ts`
/// (`limitAgentMessage`, `truncateDisplayText`, `collapseAttachedContext`).
/// These bound what crosses the bridge without touching Pi's session on disk.
public enum MessageLimits {
  public static let maxToolOutput = 512 * 1024
  public static let maxLongText = 2 * 1024 * 1024

  public static func truncateDisplayText(_ value: String, maximum: Int = maxToolOutput) -> String {
    guard value.count > maximum else { return value }
    let tailLength = maximum / 4
    let headLength = maximum - tailLength
    let head = value.prefix(headLength)
    let tail = value.suffix(tailLength)
    return "\(head)\n\n[CodePi truncated \(value.count - maximum) characters]\n\n\(tail)"
  }

  /// Collapse trailing attachment blocks into a compact 📎 list for display.
  public static func collapseAttachedContext(_ value: String) -> String {
    let pattern = "\n\nAttached file (?:`([^`\n]+)`:|path: `((?:\\\\`|[^`\n])+)`)"
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return value }
    let range = NSRange(value.startIndex..., in: value)
    let matches = regex.matches(in: value, range: range)
    guard let first = matches.first, let firstRange = Range(first.range, in: value) else { return value }
    let names = matches.compactMap { match -> String? in
      for group in [1, 2] {
        if let groupRange = Range(match.range(at: group), in: value) {
          return String(value[groupRange])
        }
      }
      return nil
    }
    let prefix = value[value.startIndex..<firstRange.lowerBound]
    return prefix + "\n\n" + names.map { "📎 \($0)" }.joined(separator: "\n")
  }

  static func limitUserText(_ value: String) -> String {
    truncateDisplayText(collapseAttachedContext(value), maximum: maxLongText)
  }

  public static func limitAgentMessage(_ message: JSONValue) -> JSONValue {
    guard var object = message.objectValue, let role = object["role"]?.stringValue else { return message }
    switch role {
    case "user":
      if let text = object["content"]?.stringValue {
        object["content"] = .string(limitUserText(text))
      } else if let parts = object["content"]?.arrayValue {
        object["content"] = .array(parts.map { part in
          guard let partObject = part.objectValue else { return part }
          if partObject["type"]?.stringValue == "text", let text = partObject["text"]?.stringValue {
            var next = partObject
            next["text"] = .string(limitUserText(text))
            return .object(next)
          }
          // Strip inline image data from renderer payloads, keep the mime type.
          var image: [String: JSONValue] = ["type": .string("image")]
          if let mime = partObject["mimeType"] { image["mimeType"] = mime }
          return .object(image)
        })
      }
    case "assistant":
      if let parts = object["content"]?.arrayValue {
        object["content"] = .array(parts.map { part in
          guard var partObject = part.objectValue else { return part }
          if partObject["type"]?.stringValue == "text", let text = partObject["text"]?.stringValue {
            partObject["text"] = .string(truncateDisplayText(text, maximum: maxLongText))
          } else if partObject["type"]?.stringValue == "thinking", let text = partObject["thinking"]?.stringValue {
            partObject["thinking"] = .string(truncateDisplayText(text, maximum: maxLongText))
          }
          return .object(partObject)
        })
      }
    case "toolResult":
      if let parts = object["content"]?.arrayValue {
        object["content"] = .array(parts.map { part in
          guard var partObject = part.objectValue, let text = partObject["text"]?.stringValue else { return part }
          partObject["text"] = .string(truncateDisplayText(text))
          return .object(partObject)
        })
      }
    case "bashExecution":
      if let output = object["output"]?.stringValue {
        object["output"] = .string(truncateDisplayText(output))
      }
    case "custom":
      if let text = object["content"]?.stringValue {
        object["content"] = .string(truncateDisplayText(text))
      } else if let parts = object["content"]?.arrayValue {
        object["content"] = .array(parts.map { part in
          guard let partObject = part.objectValue else { return part }
          if partObject["type"]?.stringValue == "text", let text = partObject["text"]?.stringValue {
            var next = partObject
            next["text"] = .string(truncateDisplayText(text))
            return .object(next)
          }
          var image: [String: JSONValue] = ["type": .string("image")]
          if let mime = partObject["mimeType"] { image["mimeType"] = mime }
          return .object(image)
        })
      }
    case "branchSummary", "compactionSummary":
      if let summary = object["summary"]?.stringValue {
        object["summary"] = .string(truncateDisplayText(summary, maximum: maxLongText))
      }
    default:
      break
    }
    return .object(object)
  }

  public static func extractToolOutput(_ result: JSONValue?) -> String {
    guard let content = result?.objectValue?["content"]?.arrayValue else { return "" }
    let output = content.map { part -> String in
      if let text = part.stringValue { return text }
      if let object = part.objectValue, object["type"]?.stringValue == "text" {
        return object["text"]?.stringValue ?? ""
      }
      return ""
    }.joined()
    return truncateDisplayText(output)
  }
}
