import Foundation

/// Port of `thread-path.ts` + `workspace-service.ts`: safe workspace file
/// enumeration and bounded read-only previews.
public enum ThreadPath {
  public static func normalizeRelativePath(_ value: String, allowRoot: Bool = false) throws -> String {
    guard !value.contains("\0"), value.count <= 16_384 else { throw BridgeError("Workspace path is invalid") }
    let portable = value.replacingOccurrences(of: "\\", with: "/")
    if portable.isEmpty {
      if allowRoot { return "" }
      throw BridgeError("Workspace path cannot be empty")
    }
    if portable.hasPrefix("/") || portable.range(of: "^[A-Za-z]:", options: .regularExpression) != nil {
      throw BridgeError("Workspace path must be relative")
    }
    let pieces = portable.components(separatedBy: "/")
    if pieces.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
      throw BridgeError("Workspace path contains an unsafe segment")
    }
    return pieces.joined(separator: "/")
  }

  public static func isInside(root: String, target: String) -> Bool {
    let rootPath = URL(fileURLWithPath: root).standardizedFileURL.path
    let targetPath = URL(fileURLWithPath: target).standardizedFileURL.path
    return targetPath == rootPath || targetPath.hasPrefix(rootPath + "/")
  }

  /// Resolve an existing path and verify both its lexical and real path stay
  /// in the thread root.
  public static func resolve(cwd: String, requestedPath: String, allowRoot: Bool = false) throws -> (root: String, requestedPath: String, realPath: String) {
    let normalized = try normalizeRelativePath(requestedPath, allowRoot: allowRoot)
    let root = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().standardizedFileURL.path
    let lexical = normalized.isEmpty
      ? root
      : URL(fileURLWithPath: root).appendingPathComponent(normalized).standardizedFileURL.path
    guard isInside(root: root, target: lexical) else { throw BridgeError("Workspace path escapes the thread directory") }
    let real = URL(fileURLWithPath: lexical).resolvingSymlinksInPath().standardizedFileURL.path
    guard isInside(root: root, target: real) else { throw BridgeError("Workspace symlink points outside the thread directory") }
    return (root, normalized, real)
  }
}

@MainActor
public final class WorkspaceService {
  public struct ScannedFile: Sendable {
    public let path: String
    public let name: String
    public let realPath: String
  }

  private struct CacheEntry {
    let expiresAt: Date
    let files: [ScannedFile]
  }

  static let maxFiles = 25_000
  static let maxDepth = 40
  static let maxPreviewBytes = 2 * 1024 * 1024
  static let ignoredDirectories: Set<String> = [
    ".git", ".pi-gui", "node_modules", "out", "release", "dist", "coverage", ".next", ".turbo"
  ]

  static let languageByExtension: [String: String] = [
    "bash": "shellscript", "c": "c", "cc": "cpp", "cpp": "cpp", "css": "css",
    "fish": "shellscript", "go": "go", "h": "c", "hpp": "cpp", "htm": "html",
    "html": "html", "java": "java", "js": "javascript", "jsx": "jsx", "json": "json",
    "kt": "kotlin", "kts": "kotlin", "less": "less", "md": "markdown", "mdx": "markdown",
    "mjs": "javascript", "cjs": "javascript", "py": "python", "rs": "rust", "scss": "scss",
    "sh": "shellscript", "sql": "sql", "svelte": "svelte", "swift": "swift", "toml": "toml",
    "ts": "typescript", "tsx": "tsx", "vue": "vue", "xml": "xml", "yaml": "yaml",
    "yml": "yaml", "zsh": "shellscript"
  ]

  private var scanCache: [String: CacheEntry] = [:]

  public init() {}

  public static func languageForPath(_ path: String) -> String {
    let name = (path as NSString).lastPathComponent.lowercased()
    if name == "dockerfile" { return "dockerfile" }
    if name == "makefile" { return "makefile" }
    return languageByExtension[(name as NSString).pathExtension] ?? "text"
  }

  public static func looksBinary(_ data: Data) -> Bool {
    let sample = data.prefix(64 * 1024)
    if sample.isEmpty { return false }
    var suspicious = 0
    for byte in sample {
      if byte == 0 { return true }
      if byte < 7 || (byte > 13 && byte < 32) { suspicious += 1 }
    }
    return Double(suspicious) / Double(sample.count) > 0.08
  }

  public func invalidate(threadId: String? = nil) {
    if let threadId { scanCache.removeValue(forKey: threadId) } else { scanCache.removeAll() }
  }

  public func listFiles(threadId: String, cwd: String) throws -> JSONValue {
    let files = try scan(threadId: threadId, cwd: cwd)
    return .array(files.map { .object(["path": .string($0.path), "name": .string($0.name)]) })
  }

  public func searchFiles(threadId: String, cwd: String, query rawQuery: String, limit rawLimit: Int) throws -> JSONValue {
    let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if query.isEmpty { return .array([]) }
    guard query.count <= 1_000 else { throw BridgeError("File search query is too long") }
    let limit = min(100, max(1, rawLimit))
    let files = try scan(threadId: threadId, cwd: cwd)
    let scored = files.compactMap { file -> (file: ScannedFile, score: Int)? in
      let path = file.path.lowercased()
      let name = file.name.lowercased()
      let score: Int
      if name == query { score = 0 }
      else if name.hasPrefix(query) { score = 1 }
      else if name.contains(query) { score = 2 }
      else if path.hasPrefix(query) { score = 3 }
      else if path.contains(query) { score = 4 }
      else { return nil }
      return (file, score)
    }
    let sorted = scored.sorted {
      $0.score != $1.score
        ? $0.score < $1.score
        : ($0.file.path.count != $1.file.path.count ? $0.file.path.count < $1.file.path.count : $0.file.path < $1.file.path)
    }
    return .array(sorted.prefix(limit).map { .object(["path": .string($0.file.path), "name": .string($0.file.name)]) })
  }

  public func recentFiles(threadId: String, cwd: String, limit rawLimit: Int = 12) throws -> JSONValue {
    let limit = min(50, max(1, rawLimit))
    let files = try scan(threadId: threadId, cwd: cwd)
    let manager = FileManager.default
    let dated = files.compactMap { file -> (file: ScannedFile, modified: Date)? in
      guard let date = (try? manager.attributesOfItem(atPath: file.realPath))?[.modificationDate] as? Date else {
        return nil
      }
      return (file, date)
    }
    return .array(dated.sorted { $0.modified > $1.modified }.prefix(limit).map {
      .object(["path": .string($0.file.path), "name": .string($0.file.name)])
    })
  }

  public func readFile(cwd: String, relativePath: String) throws -> JSONValue {
    let resolved = try ThreadPath.resolve(cwd: cwd, requestedPath: relativePath)
    guard let handle = FileHandle(forReadingAtPath: resolved.realPath) else {
      throw BridgeError("Workspace file could not be opened")
    }
    defer { try? handle.close() }
    let attributes = try FileManager.default.attributesOfItem(atPath: resolved.realPath)
    guard (attributes[.type] as? FileAttributeType) == .typeRegular else {
      throw BridgeError("Workspace path is not a file")
    }
    let size = (attributes[.size] as? Int) ?? 0
    let modified = ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
    let data = (try? handle.read(upToCount: Self.maxPreviewBytes)) ?? Data()
    let binary = Self.looksBinary(data)
    var content = binary ? "" : String(decoding: data, as: UTF8.self)
    if content.hasPrefix("\u{FEFF}") { content.removeFirst() }
    return .object([
      "path": .string(resolved.requestedPath),
      "content": .string(content),
      "language": .string(Self.languageForPath(resolved.requestedPath)),
      "size": .number(Double(size)),
      "modifiedAt": .number(modified),
      "binary": .bool(binary),
      "truncated": .bool(size > data.count)
    ])
  }

  private func scan(threadId: String, cwd: String) throws -> [ScannedFile] {
    if let cached = scanCache[threadId], cached.expiresAt > Date() { return cached.files }
    let root = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().standardizedFileURL.path
    var files: [ScannedFile] = []
    let manager = FileManager.default

    func walk(directory: String, prefix: String, depth: Int) {
      if depth > Self.maxDepth || files.count >= Self.maxFiles { return }
      let entries = (try? manager.contentsOfDirectory(atPath: directory)) ?? []
      for name in entries {
        if files.count >= Self.maxFiles { break }
        if name == ".DS_Store" { continue }
        let relativePath = prefix.isEmpty ? name : "\(prefix)/\(name)"
        let absolute = directory + "/" + name
        var isSymlink = false
        if let type = (try? manager.attributesOfItem(atPath: absolute))?[.type] as? FileAttributeType {
          isSymlink = type == .typeSymbolicLink
          if type == .typeDirectory {
            if !Self.ignoredDirectories.contains(name) {
              walk(directory: absolute, prefix: relativePath, depth: depth + 1)
            }
            continue
          }
          if type == .typeRegular {
            files.append(ScannedFile(path: relativePath, name: name, realPath: absolute))
            continue
          }
        }
        guard isSymlink else { continue }
        let target = URL(fileURLWithPath: absolute).resolvingSymlinksInPath().standardizedFileURL.path
        guard ThreadPath.isInside(root: root, target: target) else { continue }
        var isDirectory: ObjCBool = false
        // Directory symlinks are not traversed: avoids cycles, keeps
        // enumeration rooted in the visible workspace tree.
        if manager.fileExists(atPath: target, isDirectory: &isDirectory), !isDirectory.boolValue {
          files.append(ScannedFile(path: relativePath, name: name, realPath: target))
        }
      }
    }

    walk(directory: root, prefix: "", depth: 0)
    files.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    scanCache[threadId] = CacheEntry(expiresAt: Date().addingTimeInterval(1), files: files)
    return files
  }
}
