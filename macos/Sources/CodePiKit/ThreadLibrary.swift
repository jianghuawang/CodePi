import Foundation

/// Port of `shared/tags.ts` (strict variant) and `thread-library.ts`.
public enum Tags {
  public static let maximumTags = 24
  public static let maximumTagLength = 48

  public static func normalize(_ values: [String]) throws -> [String] {
    guard values.count <= maximumTags * 2 else { throw BridgeError("Tags are invalid") }
    var result: [String] = []
    var seen = Set<String>()
    for value in values {
      guard !value.contains("\0") else { throw BridgeError("Tag is invalid") }
      let tag = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      if tag.isEmpty { continue }
      guard tag.count <= maximumTagLength else {
        throw BridgeError("Tag is longer than \(maximumTagLength) characters")
      }
      let key = tag.lowercased()
      if seen.contains(key) { continue }
      seen.insert(key)
      result.append(tag)
      if result.count > maximumTags { throw BridgeError("A maximum of \(maximumTags) tags is allowed") }
    }
    return result
  }
}

public struct ThreadUpdate: Sendable {
  public var title: String?
  public var pinned: Bool?
  public var archived: Bool?
  public var unread: Bool?
  public var tags: [String]?

  public init(from args: JSONValue) throws {
    guard let record = args.objectValue else { throw BridgeError("Thread update is invalid") }
    for key in record.keys where !["title", "pinned", "archived", "unread", "tags"].contains(key) {
      throw BridgeError("Thread update field \(key) is not supported")
    }
    if let raw = record["title"] {
      guard let text = raw.stringValue else { throw BridgeError("Thread title is invalid") }
      title = try ThreadLibrary.requiredText(text, name: "Thread title", maximum: 240)
    }
    if let raw = record["pinned"] {
      guard let value = raw.boolValue else { throw BridgeError("Pinned state is invalid") }
      pinned = value
    }
    if let raw = record["archived"] {
      guard let value = raw.boolValue else { throw BridgeError("Archived state is invalid") }
      archived = value
    }
    if let raw = record["unread"] {
      guard let value = raw.boolValue else { throw BridgeError("Unread state is invalid") }
      unread = value
    }
    if let raw = record["tags"] {
      guard let values = raw.arrayValue else { throw BridgeError("Tags are invalid") }
      tags = try Tags.normalize(values.map { $0.stringValue ?? "\0" })
    }
  }
}

@MainActor
public enum ThreadLibrary {
  nonisolated public static func requiredText(_ value: String, name: String, maximum: Int) throws -> String {
    guard !value.contains("\0") else { throw BridgeError("\(name) is invalid") }
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty, normalized.count <= maximum else { throw BridgeError("\(name) is invalid") }
    return normalized
  }

  public static func updateThreadMetadata(store: StateStore, threadId: String, update: ThreadUpdate) throws -> ThreadRecord {
    var result: ThreadRecord?
    try store.update { state in
      guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else {
        throw BridgeError("Thread not found")
      }
      var thread = state.threads[index]
      if thread.deletedAt != nil && (update.pinned == true || update.archived != nil) {
        throw BridgeError("Restore the thread before changing its active state")
      }
      if update.pinned == true && (update.archived == true || (update.archived != false && thread.archived)) {
        throw BridgeError("Only active threads can be pinned")
      }
      if let title = update.title { thread.title = title }
      if let tags = update.tags { thread.tags = tags }
      if let archived = update.archived {
        thread.archived = archived
        if archived { thread.pinned = false }
      }
      if let pinned = update.pinned { thread.pinned = pinned }
      if let unread = update.unread { thread.unread = unread }
      state.threads[index] = thread
      result = thread
    }
    guard let result else { throw BridgeError("Thread update failed") }
    return result
  }

  public static func softTrashThread(store: StateStore, threadId: String, now: Double = nowMilliseconds()) throws -> ThreadRecord {
    var result: ThreadRecord?
    try store.update { state in
      guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else {
        throw BridgeError("Thread not found")
      }
      var thread = state.threads[index]
      if thread.deletedAt == nil { thread.deletedAt = now }
      thread.status = "idle"
      thread.unread = false
      thread.lastError = nil
      state.threads[index] = thread
      if state.selectedThreadId == threadId { state.selectedThreadId = nil }
      result = thread
    }
    guard let result else { throw BridgeError("Thread trash operation failed") }
    return result
  }

  public static func restoreTrashedThread(store: StateStore, threadId: String) throws -> ThreadRecord {
    var result: ThreadRecord?
    try store.update { state in
      guard let index = state.threads.firstIndex(where: { $0.id == threadId }) else {
        throw BridgeError("Thread not found")
      }
      var thread = state.threads[index]
      guard thread.deletedAt != nil else { throw BridgeError("Thread is not in Trash") }
      thread.deletedAt = nil
      thread.status = "idle"
      thread.unread = false
      state.threads[index] = thread
      result = thread
    }
    guard let result else { throw BridgeError("Thread restore operation failed") }
    return result
  }

  public static func listPromptTemplates(store: StateStore) -> JSONValue {
    let sorted = store.snapshot().promptLibrary.sorted { left, right in
      left.updatedAt != right.updatedAt ? left.updatedAt > right.updatedAt : left.title < right.title
    }
    return .array(sorted.map(\.payload))
  }

  public static func savePromptTemplate(store: StateStore, id rawId: String?, title rawTitle: String, prompt: String, now: Double = nowMilliseconds()) throws -> Void {
    let id: String
    if let rawId {
      guard rawId.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$", options: .regularExpression) != nil else {
        throw BridgeError("Prompt id is invalid")
      }
      id = rawId
    } else {
      id = UUID().uuidString.lowercased()
    }
    let title = try requiredText(rawTitle, name: "Prompt title", maximum: 120)
    guard !prompt.contains("\0"), prompt.count <= 200_000 else { throw BridgeError("Prompt is invalid") }
    store.update { state in
      if let index = state.promptLibrary.firstIndex(where: { $0.id == id }) {
        state.promptLibrary[index].title = title
        state.promptLibrary[index].prompt = prompt
        state.promptLibrary[index].updatedAt = now
      } else {
        state.promptLibrary.append(PromptTemplate(id: id, title: title, prompt: prompt, createdAt: now, updatedAt: now))
      }
    }
  }

  public static func deletePromptTemplate(store: StateStore, id: String) throws {
    guard id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$", options: .regularExpression) != nil else {
      throw BridgeError("Prompt id is invalid")
    }
    try store.update { state in
      guard let index = state.promptLibrary.firstIndex(where: { $0.id == id }) else {
        throw BridgeError("Prompt not found")
      }
      state.promptLibrary.remove(at: index)
    }
  }

  // MARK: - Usage dashboard (aggregateUsageLedger parity: 30 local days)

  public static func usageDashboard(entries: [UsageLedgerEntry], projectId: String?, now: Date = Date()) -> JSONValue {
    let calendar = Calendar.current
    let todayStart = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
    let monthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: now))!
      .timeIntervalSince1970 * 1000
    var dayKeys: [String] = []
    var dayTotals: [String: (tokens: Double, cost: Double, turns: Double)] = [:]
    for offset in stride(from: 29, through: 0, by: -1) {
      let day = calendar.date(byAdding: .day, value: -offset, to: calendar.startOfDay(for: now))!
      let key = dateKey(day, calendar: calendar)
      dayKeys.append(key)
      dayTotals[key] = (0, 0, 0)
    }
    var today: (tokens: Double, cost: Double, turns: Double) = (0, 0, 0)
    var month: (tokens: Double, cost: Double, turns: Double) = (0, 0, 0)
    let nowMs = now.timeIntervalSince1970 * 1000
    for entry in entries {
      if let projectId, entry.projectId != projectId { continue }
      if entry.timestamp > nowMs { continue }
      let tokens = max(0, entry.tokens)
      let cost = max(0, entry.cost)
      if entry.timestamp >= todayStart { today = (today.tokens + tokens, today.cost + cost, today.turns + 1) }
      if entry.timestamp >= monthStart { month = (month.tokens + tokens, month.cost + cost, month.turns + 1) }
      let key = dateKey(Date(timeIntervalSince1970: entry.timestamp / 1000), calendar: calendar)
      if let existing = dayTotals[key] {
        dayTotals[key] = (existing.tokens + tokens, existing.cost + cost, existing.turns + 1)
      }
    }
    func period(_ value: (tokens: Double, cost: Double, turns: Double)) -> [String: JSONValue] {
      ["tokens": .number(value.tokens), "cost": .number(value.cost), "turns": .number(value.turns)]
    }
    return .object([
      "today": .object(period(today)),
      "month": .object(period(month)),
      "days": .array(dayKeys.map { key in
        var object = period(dayTotals[key] ?? (0, 0, 0))
        object["date"] = .string(key)
        return .object(object)
      })
    ])
  }

  private static func dateKey(_ date: Date, calendar: Calendar) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }
}
