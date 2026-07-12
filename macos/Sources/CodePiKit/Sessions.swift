import CryptoKit
import Foundation

/// Port of `sessions.ts`: Pi-owned session JSONL discovery, tree parsing, and
/// branch cloning. Pi remains the source of truth; CodePi only reads headers
/// and writes new Pi-compatible files when branching or duplicating.
public enum Sessions {
  public struct Discovered: Sendable {
    public let file: String
    public let cwd: String
    public let title: String
    public let createdAt: Double
    public let updatedAt: Double
  }

  public static func agentDirectory(env: [String: String]) -> String {
    let fromEnv = env["PI_CODING_AGENT_DIR"] ?? ProcessInfo.processInfo.environment["PI_CODING_AGENT_DIR"]
    if let fromEnv, !fromEnv.isEmpty { return URL(fileURLWithPath: fromEnv).standardizedFileURL.path }
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".pi/agent").standardizedFileURL.path
  }

  public static func sessionDirectoryForCwd(_ cwd: String, env: [String: String]) -> String {
    let resolved = URL(fileURLWithPath: cwd).standardizedFileURL.path
    var trimmed = resolved
    if trimmed.hasPrefix("/") || trimmed.hasPrefix("\\") { trimmed.removeFirst() }
    let safePath = "--" + trimmed
      .replacingOccurrences(of: "/", with: "-")
      .replacingOccurrences(of: "\\", with: "-")
      .replacingOccurrences(of: ":", with: "-") + "--"
    return agentDirectory(env: env) + "/sessions/" + safePath
  }

  public static func recoveredThreadId(sessionFile: String) -> String {
    let resolved = URL(fileURLWithPath: sessionFile).standardizedFileURL.path
    let digest = SHA256.hash(data: Data(resolved.utf8))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return "session-\(hex.prefix(20))"
  }

  // MARK: - Discovery

  static func titleFromPrefix(_ prefix: String) -> String {
    var firstPrompt = ""
    var latestName = ""
    for line in prefix.split(separator: "\n", omittingEmptySubsequences: true) {
      guard let value = try? JSONValue.parse(String(line)), let record = value.objectValue else { continue }
      if record["type"]?.stringValue == "session_info", let name = record["name"]?.stringValue {
        latestName = name
      }
      if firstPrompt.isEmpty,
         record["type"]?.stringValue == "message",
         let message = record["message"]?.objectValue,
         message["role"]?.stringValue == "user" {
        if let text = message["content"]?.stringValue {
          firstPrompt = text
        } else if let parts = message["content"]?.arrayValue {
          firstPrompt = parts
            .compactMap { part -> String? in
              guard let object = part.objectValue, object["type"]?.stringValue == "text" else { return nil }
              return object["text"]?.stringValue
            }
            .joined(separator: " ")
        }
      }
    }
    var title = (latestName.isEmpty ? firstPrompt : latestName)
    if title.isEmpty { title = "Recovered Pi session" }
    title = title
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    return title.count > 72 ? String(title.prefix(69)) + "…" : title
  }

  static func readPrefix(of url: URL, maximum: Int = 256 * 1024) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    guard let data = try? handle.read(upToCount: maximum) else { return nil }
    return String(decoding: data, as: UTF8.self)
  }

  /// Discovers Pi sessions whose header cwd matches a known project or thread
  /// working directory. Returns sessions grouped by project id.
  public static func discoverProjectSessions(
    projects: [ProjectRecord],
    knownThreads: [ThreadRecord],
    env: [String: String]
  ) -> [String: [Discovered]] {
    guard !projects.isEmpty else { return [:] }
    var projectByCwd: [String: String] = [:]
    for project in projects {
      projectByCwd[URL(fileURLWithPath: project.path).standardizedFileURL.path] = project.id
    }
    for thread in knownThreads {
      if projects.contains(where: { $0.id == thread.projectId }) {
        projectByCwd[URL(fileURLWithPath: thread.cwd).standardizedFileURL.path] = thread.projectId
      }
    }
    let fileManager = FileManager.default
    let sessionsRoot = URL(fileURLWithPath: agentDirectory(env: env)).appendingPathComponent("sessions")
    var files: [URL] = []
    for directory in (try? fileManager.contentsOfDirectory(at: sessionsRoot, includingPropertiesForKeys: [.isDirectoryKey])) ?? [] {
      guard (try? directory.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
      for file in (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
        if file.pathExtension == "jsonl" { files.append(file) }
        if files.count >= 20_000 { break }
      }
    }
    var result: [String: [Discovered]] = [:]
    for file in files {
      guard let prefix = readPrefix(of: file) else { continue }
      guard let firstLine = prefix.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first,
            let header = try? JSONValue.parse(String(firstLine)),
            let object = header.objectValue,
            object["type"]?.stringValue == "session",
            object["id"]?.stringValue != nil,
            let cwd = object["cwd"]?.stringValue
      else { continue }
      let sessionCwd = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().standardizedFileURL.path
      guard let projectId = projectByCwd[sessionCwd] else { continue }
      let attributes = try? fileManager.attributesOfItem(atPath: file.path)
      let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
      let created: Double
      if let stamp = object["timestamp"]?.stringValue, let date = parseISOTimestamp(stamp) {
        created = date.timeIntervalSince1970 * 1000
      } else {
        created = ((attributes?[.creationDate] as? Date)?.timeIntervalSince1970 ?? modified) * 1000
      }
      result[projectId, default: []].append(Discovered(
        file: file.standardizedFileURL.path,
        cwd: URL(fileURLWithPath: sessionCwd).standardizedFileURL.path,
        title: titleFromPrefix(prefix),
        createdAt: created,
        updatedAt: modified * 1000
      ))
    }
    for (key, list) in result {
      result[key] = list.sorted { $0.updatedAt > $1.updatedAt }
    }
    return result
  }

  // MARK: - Documents, trees, clones

  struct Document {
    let header: [String: JSONValue]
    let entries: [[String: JSONValue]]
  }

  static func parseDocument(_ content: String, source: String) throws -> Document {
    var values: [JSONValue] = []
    let lines = content.components(separatedBy: "\n")
    for (index, line) in lines.enumerated() {
      if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
      do {
        values.append(try JSONValue.parse(line))
      } catch {
        let partialFinalRecord = index == lines.count - 1 && !content.hasSuffix("\n")
        if partialFinalRecord { continue }
        throw BridgeError("Invalid Pi session record in \(source) at line \(index + 1)")
      }
    }
    guard let header = values.first?.objectValue,
          header["type"]?.stringValue == "session",
          header["id"]?.stringValue != nil,
          header["cwd"]?.stringValue != nil
    else { throw BridgeError("Invalid Pi session header") }
    let entries = values.dropFirst().compactMap { value -> [String: JSONValue]? in
      guard let object = value.objectValue,
            object["type"]?.stringValue != nil,
            object["id"]?.stringValue != nil,
            object["parentId"] != nil
      else { return nil }
      let parent = object["parentId"]!
      guard parent == .null || parent.stringValue != nil else { return nil }
      return object
    }
    return Document(header: header, entries: entries)
  }

  public static func readSessionMessages(sessionFile: String) throws -> JSONValue {
    let content = try String(contentsOfFile: sessionFile, encoding: .utf8)
    let document = try parseDocument(content, source: sessionFile)
    let messages = document.entries.compactMap { entry -> JSONValue? in
      guard entry["type"]?.stringValue == "message", let message = entry["message"] else { return nil }
      return message
    }
    return .array(messages)
  }

  /// Builds the id/parentId tree with label annotations — `parseSessionTree`
  /// parity (timestamp ordering, cycle-safe).
  public static func parseSessionTree(entries: [[String: JSONValue]]) -> (tree: JSONValue, leafId: JSONValue) {
    var labels: [String: (label: String?, timestamp: String?)] = [:]
    for entry in entries where entry["type"]?.stringValue == "label" {
      guard let target = entry["targetId"]?.stringValue else { continue }
      let label = entry["label"]?.stringValue
      labels[target] = (label?.isEmpty == false ? label : nil, entry["timestamp"]?.stringValue)
    }
    var childIds: [String: [String]] = [:]
    var byId: [String: [String: JSONValue]] = [:]
    var roots: [String] = []
    for entry in entries {
      guard let id = entry["id"]?.stringValue else { continue }
      byId[id] = entry
    }
    for entry in entries {
      guard let id = entry["id"]?.stringValue else { continue }
      let parentId = entry["parentId"]?.stringValue
      if let parentId, parentId != id, byId[parentId] != nil {
        childIds[parentId, default: []].append(id)
      } else {
        roots.append(id)
      }
    }
    func build(_ id: String, ancestors: Set<String>) -> JSONValue {
      let entry = byId[id] ?? [:]
      var node: [String: JSONValue] = ["entry": .object(entry), "children": .array([])]
      if let label = labels[id] {
        if let text = label.label { node["label"] = .string(text) }
        if let stamp = label.timestamp { node["labelTimestamp"] = .string(stamp) }
      }
      if !ancestors.contains(id) {
        let children = (childIds[id] ?? [])
          .sorted { (byId[$0]?["timestamp"]?.stringValue ?? "") < (byId[$1]?["timestamp"]?.stringValue ?? "") }
          .map { build($0, ancestors: ancestors.union([id])) }
        node["children"] = .array(children)
      }
      return .object(node)
    }
    let sortedRoots = roots
      .sorted { (byId[$0]?["timestamp"]?.stringValue ?? "") < (byId[$1]?["timestamp"]?.stringValue ?? "") }
      .map { build($0, ancestors: []) }
    let leaf = entries.last?["id"]?.stringValue
    return (.array(sortedRoots), leaf.map(JSONValue.string) ?? .null)
  }

  public static func readSessionTree(sessionFile: String) throws -> (tree: JSONValue, leafId: JSONValue) {
    let content = try String(contentsOfFile: sessionFile, encoding: .utf8)
    let document = try parseDocument(content, source: sessionFile)
    return parseSessionTree(entries: document.entries)
  }

  /// Clone the ancestry of `entryId` into a new Pi-compatible session file.
  public static func cloneSessionBranch(
    sourceFile: String,
    entryId: String,
    targetCwd: String,
    env: [String: String],
    rewindSelectedUser: Bool
  ) throws -> String {
    let content = try String(contentsOfFile: sourceFile, encoding: .utf8)
    let document = try parseDocument(content, source: sourceFile)
    var byId: [String: [String: JSONValue]] = [:]
    for entry in document.entries {
      if let id = entry["id"]?.stringValue { byId[id] = entry }
    }
    guard let selected = byId[entryId] else { throw BridgeError("The selected history entry no longer exists") }
    let selectedRole = selected["message"]?.objectValue?["role"]?.stringValue
    let targetEntryId: String?
    if rewindSelectedUser && selected["type"]?.stringValue == "message" && selectedRole == "user" {
      targetEntryId = selected["parentId"]?.stringValue
    } else {
      targetEntryId = entryId
    }
    var branch: [[String: JSONValue]] = []
    var seen = Set<String>()
    var current = targetEntryId.flatMap { byId[$0] }
    while let entry = current {
      guard let id = entry["id"]?.stringValue else { break }
      guard seen.insert(id).inserted else { throw BridgeError("The Pi session tree contains a cycle") }
      branch.append(entry)
      current = entry["parentId"]?.stringValue.flatMap { byId[$0] }
    }
    branch.reverse()
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let now = formatter.string(from: Date())
    let sessionId = UUID().uuidString.lowercased()
    var header: [String: JSONValue] = [
      "type": .string("session"),
      "version": document.header["version"] ?? .number(3),
      "id": .string(sessionId),
      "timestamp": .string(now),
      "cwd": .string(URL(fileURLWithPath: targetCwd).standardizedFileURL.path),
      "parentSession": .string(URL(fileURLWithPath: sourceFile).standardizedFileURL.path)
    ]
    if header["version"]?.numberValue == nil { header["version"] = .number(3) }
    let directory = sessionDirectoryForCwd(targetCwd, env: env)
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    let safeStamp = now.replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
    let target = directory + "/\(safeStamp)_\(sessionId).jsonl"
    guard !FileManager.default.fileExists(atPath: target) else {
      throw BridgeError("A session file already exists at \(target)")
    }
    let lines = ([JSONValue.object(header)] + branch.map(JSONValue.object)).map { $0.jsonString() }
    let data = Data((lines.joined(separator: "\n") + "\n").utf8)
    FileManager.default.createFile(atPath: target, contents: data, attributes: [.posixPermissions: 0o600])
    return target
  }
}

/// Pi timestamps may or may not carry fractional seconds.
func parseISOTimestamp(_ value: String) -> Date? {
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = fractional.date(from: value) { return date }
  let plain = ISO8601DateFormatter()
  plain.formatOptions = [.withInternetDateTime]
  return plain.date(from: value)
}
