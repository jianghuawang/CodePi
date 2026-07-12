import Foundation

/// Port of `search-service.ts`: metadata-tier matches (title/tag) plus a
/// transcript tier that tail-reads session JSONL with an LRU cache.
@MainActor
public final class TranscriptSearch {
  private struct CacheEntry {
    let size: Int
    let modifiedAt: Date
    let characters: Int
    let messages: [(timestamp: Double?, text: String, normalized: String)]
  }

  private var cache: [String: CacheEntry] = [:]
  private var cacheOrder: [String] = []
  private var cachedCharacters = 0
  private let maximumCacheEntries = 32
  private let maximumCachedCharacters = 32 * 1024 * 1024
  private static let maximumSessionBytes = 16 * 1024 * 1024
  private static let maximumMessages = 5_000
  private static let maximumMessageText = 64 * 1024

  public init() {}

  public func clear(sessionFile: String? = nil) {
    if let sessionFile {
      if let entry = cache.removeValue(forKey: sessionFile) { cachedCharacters -= entry.characters }
      cacheOrder.removeAll { $0 == sessionFile }
    } else {
      cache.removeAll()
      cacheOrder.removeAll()
      cachedCharacters = 0
    }
  }

  static func normalize(_ value: String) -> String {
    value.precomposedStringWithCompatibilityMapping
      .lowercased()
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
  }

  static func messageText(_ message: [String: JSONValue]) -> String {
    func textParts(_ content: JSONValue?) -> String {
      if let text = content?.stringValue { return text }
      return (content?.arrayValue ?? []).compactMap { part -> String? in
        guard let object = part.objectValue, object["type"]?.stringValue == "text" else { return nil }
        return object["text"]?.stringValue
      }.joined(separator: "\n")
    }
    switch message["role"]?.stringValue {
    case "user":
      return textParts(message["content"])
    case "assistant":
      return (message["content"]?.arrayValue ?? []).compactMap { part -> String? in
        guard let object = part.objectValue else { return nil }
        switch object["type"]?.stringValue {
        case "text": return object["text"]?.stringValue
        case "thinking": return object["thinking"]?.stringValue
        case "toolCall":
          let name = object["name"]?.stringValue ?? ""
          let args = object["arguments"]?.jsonString() ?? ""
          return "\(name)\n\(args)"
        default: return nil
        }
      }.joined(separator: "\n")
    case "toolResult":
      let name = message["toolName"]?.stringValue ?? ""
      let body = (message["content"]?.arrayValue ?? []).compactMap { $0.objectValue?["text"]?.stringValue }.joined(separator: "\n")
      return "\(name)\n\(body)"
    case "bashExecution":
      return "\(message["command"]?.stringValue ?? "")\n\(message["output"]?.stringValue ?? "")"
    case "custom":
      guard message["display"]?.boolValue == true else { return "" }
      return "\(message["customType"]?.stringValue ?? "")\n\(textParts(message["content"]))"
    case "branchSummary", "compactionSummary":
      return message["summary"]?.stringValue ?? ""
    default:
      return ""
    }
  }

  static func excerpt(_ text: String, terms: [String], maximum: Int = 220) -> String {
    let compact = text
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    if compact.count <= maximum { return compact }
    let lowered = compact.lowercased()
    var firstIndex = -1
    for term in terms {
      if let range = lowered.range(of: term.lowercased()) {
        let offset = lowered.distance(from: lowered.startIndex, to: range.lowerBound)
        firstIndex = firstIndex < 0 ? offset : min(firstIndex, offset)
      }
    }
    let center = max(0, firstIndex)
    let start = max(0, min(compact.count - maximum, center - maximum / 3))
    let slice = String(Array(compact)[start..<min(compact.count, start + maximum)])
      .trimmingCharacters(in: .whitespaces)
    return "\(start > 0 ? "…" : "")\(slice)\(start + maximum < compact.count ? "…" : "")"
  }

  static func recencyBonus(_ updatedAt: Double) -> Double {
    let ageInDays = max(0, (nowMilliseconds() - updatedAt) / 86_400_000)
    return max(0, 10 - log2(ageInDays + 1))
  }

  /// Search title/tag metadata and recent transcript content. `threads` should
  /// already exclude trashed entries when the caller wants active-only scope.
  public func search(query rawQuery: String, threads: [ThreadRecord], projectNames: [String: String], limit: Int = 80) -> JSONValue {
    let normalizedQuery = Self.normalize(String(rawQuery.prefix(512)))
    let terms = normalizedQuery.split(separator: " ").map(String.init)
    let candidates = threads.sorted {
      ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt)
    }
    var results: [(score: Double, title: String, payload: [String: JSONValue])] = []

    for thread in candidates {
      let title = Self.normalize(thread.title)
      let matchingTag = thread.tags.first { tag in
        let normalizedTag = Self.normalize(tag)
        return normalizedQuery.isEmpty
          || normalizedTag.contains(normalizedQuery)
          || terms.allSatisfy { normalizedTag.contains($0) }
      }
      let titleMatches = normalizedQuery.isEmpty
        || title.contains(normalizedQuery)
        || terms.allSatisfy { title.contains($0) }
      if titleMatches || matchingTag != nil {
        let score = (titleMatches ? 120.0 : 90.0) + (thread.pinned ? 20 : 0) + Self.recencyBonus(thread.updatedAt)
        results.append((score, thread.title, [
          "threadId": .string(thread.id),
          "projectId": .string(thread.projectId),
          "title": .string(thread.title),
          "snippet": .string(matchingTag != nil && !titleMatches ? matchingTag! : thread.title),
          "timestamp": .number(thread.updatedAt)
        ]))
      }
    }

    if !terms.isEmpty {
      for thread in candidates.prefix(500) where thread.sessionFile != nil {
        let messages = indexedMessages(sessionFile: thread.sessionFile!)
        var count = 0
        for message in messages.reversed() {
          guard terms.allSatisfy({ message.normalized.contains($0) }) else { continue }
          let exact = message.normalized.contains(normalizedQuery)
          results.append(((exact ? 70.0 : 55.0) + Self.recencyBonus(thread.updatedAt), thread.title, [
            "threadId": .string(thread.id),
            "projectId": .string(thread.projectId),
            "title": .string(thread.title),
            "snippet": .string(Self.excerpt(message.text, terms: terms)),
            "timestamp": .number(message.timestamp ?? thread.updatedAt)
          ]))
          count += 1
          if count >= 2 { break }
        }
      }
    }
    _ = projectNames
    let sorted = results.sorted { $0.score != $1.score ? $0.score > $1.score : $0.title < $1.title }
    return .array(sorted.prefix(limit).map { .object($0.payload) })
  }

  private func indexedMessages(sessionFile: String) -> [(timestamp: Double?, text: String, normalized: String)] {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: sessionFile),
          let size = attributes[.size] as? Int,
          let modified = attributes[.modificationDate] as? Date
    else { return [] }
    if let cached = cache[sessionFile], cached.size == size, cached.modifiedAt == modified {
      cacheOrder.removeAll { $0 == sessionFile }
      cacheOrder.append(sessionFile)
      return cached.messages
    }
    guard let handle = FileHandle(forReadingAtPath: sessionFile) else { return [] }
    defer { try? handle.close() }
    let start = max(0, size - Self.maximumSessionBytes)
    if start > 0 { try? handle.seek(toOffset: UInt64(start)) }
    let data = (try? handle.readToEnd()) ?? Data()
    var lines = String(decoding: data, as: UTF8.self).components(separatedBy: "\n")
    // A tail read normally begins in the middle of a JSON object.
    if start > 0, !lines.isEmpty { lines.removeFirst() }

    var messages: [(timestamp: Double?, text: String, normalized: String)] = []
    for line in lines {
      guard !line.trimmingCharacters(in: .whitespaces).isEmpty,
            let entry = try? JSONValue.parse(line),
            let object = entry.objectValue,
            object["type"]?.stringValue == "message",
            let message = object["message"]?.objectValue,
            message["role"]?.stringValue != nil
      else { continue }
      var text = Self.messageText(message).replacingOccurrences(of: "\0", with: "")
      text = String(text.prefix(Self.maximumMessageText)).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      messages.append((message["timestamp"]?.numberValue, text, Self.normalize(text)))
      if messages.count > Self.maximumMessages { messages.removeFirst() }
    }

    if let previous = cache[sessionFile] { cachedCharacters -= previous.characters }
    let characters = messages.reduce(0) { $0 + $1.text.count + $1.normalized.count }
    cache[sessionFile] = CacheEntry(size: size, modifiedAt: modified, characters: characters, messages: messages)
    cacheOrder.removeAll { $0 == sessionFile }
    cacheOrder.append(sessionFile)
    cachedCharacters += characters
    while cache.count > maximumCacheEntries || cachedCharacters > maximumCachedCharacters {
      guard let oldest = cacheOrder.first else { break }
      cacheOrder.removeFirst()
      if let entry = cache.removeValue(forKey: oldest) { cachedCharacters -= entry.characters }
    }
    return messages
  }
}
