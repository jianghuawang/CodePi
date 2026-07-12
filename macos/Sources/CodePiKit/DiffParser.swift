import Foundation

/// Unified-diff parser producing the same `DiffFile` shape the renderer gets
/// from Electron (`parse-diff` + `mapDiff` in git-service.ts): change content
/// keeps its leading marker character, normal lines carry both line numbers.
public enum DiffParser {
  public struct ParsedFile {
    public var from = ""
    public var to = ""
    public var additions = 0
    public var deletions = 0
    public var binary = false
    public var chunks: [JSONValue] = []
    // Chunk under construction.
    var changes: [JSONValue] = []
    var header: [String: Double] = [:]
    var chunkContent = ""
    var oldLine = 0
    var newLine = 0
    var inChunk = false
  }

  static func cleanPath(_ raw: String, prefix: String) -> String {
    var value = raw
    if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
      value = String(value.dropFirst().dropLast())
    }
    if value == "/dev/null" || value == "NUL" { return "" }
    if value.hasPrefix(prefix) { value = String(value.dropFirst(prefix.count)) }
    return value
  }

  public static func parse(_ raw: String) -> [ParsedFile] {
    var files: [ParsedFile] = []

    func closeChunk() {
      guard files.indices.last != nil, files[files.count - 1].inChunk else { return }
      var file = files[files.count - 1]
      var chunk: [String: JSONValue] = [
        "content": .string(file.chunkContent),
        "oldStart": .number(file.header["oldStart"] ?? 0),
        "oldLines": .number(file.header["oldLines"] ?? 0),
        "newStart": .number(file.header["newStart"] ?? 0),
        "newLines": .number(file.header["newLines"] ?? 0)
      ]
      chunk["changes"] = .array(file.changes)
      file.chunks.append(.object(chunk))
      file.changes = []
      file.inChunk = false
      files[files.count - 1] = file
    }

    for line in raw.components(separatedBy: "\n") {
      if line.hasPrefix("diff --git ") {
        closeChunk()
        files.append(ParsedFile())
        continue
      }
      guard !files.isEmpty else { continue }
      var file = files[files.count - 1]

      if !file.inChunk {
        if line.hasPrefix("--- ") {
          file.from = cleanPath(String(line.dropFirst(4)), prefix: "a/")
          files[files.count - 1] = file
          continue
        }
        if line.hasPrefix("+++ ") {
          file.to = cleanPath(String(line.dropFirst(4)), prefix: "b/")
          files[files.count - 1] = file
          continue
        }
        if line.hasPrefix("rename from ") {
          file.from = String(line.dropFirst("rename from ".count))
          files[files.count - 1] = file
          continue
        }
        if line.hasPrefix("rename to ") {
          file.to = String(line.dropFirst("rename to ".count))
          files[files.count - 1] = file
          continue
        }
      }
      if line.hasPrefix("Binary files ") && line.hasSuffix(" differ") {
        file.binary = true
        files[files.count - 1] = file
        continue
      }
      if line.hasPrefix("@@") {
        closeChunk()
        file = files[files.count - 1]
        guard let header = parseChunkHeader(line) else { continue }
        file.inChunk = true
        file.chunkContent = line
        file.header = header
        file.oldLine = Int(header["oldStart"] ?? 0)
        file.newLine = Int(header["newStart"] ?? 0)
        files[files.count - 1] = file
        continue
      }
      guard file.inChunk else { continue }
      if line.hasPrefix("+") {
        file.additions += 1
        file.changes.append(.object([
          "type": .string("add"),
          "content": .string(line),
          "newNumber": .number(Double(file.newLine))
        ]))
        file.newLine += 1
      } else if line.hasPrefix("-") {
        file.deletions += 1
        file.changes.append(.object([
          "type": .string("del"),
          "content": .string(line),
          "oldNumber": .number(Double(file.oldLine))
        ]))
        file.oldLine += 1
      } else if line.hasPrefix(" ") || line.isEmpty {
        // Git emits a bare empty line for an empty context row.
        file.changes.append(.object([
          "type": .string("normal"),
          "content": .string(line.isEmpty ? " " : line),
          "oldNumber": .number(Double(file.oldLine)),
          "newNumber": .number(Double(file.newLine))
        ]))
        file.oldLine += 1
        file.newLine += 1
      }
      // Lines like "\\ No newline at end of file" are skipped, matching what
      // the renderer actually displays.
      files[files.count - 1] = file
    }
    closeChunk()
    return files
  }

  static func parseChunkHeader(_ line: String) -> [String: Double]? {
    let pattern = #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line))
    else { return nil }
    func group(_ index: Int, fallback: Double) -> Double {
      guard let range = Range(match.range(at: index), in: line) else { return fallback }
      return Double(line[range]) ?? fallback
    }
    return [
      "oldStart": group(1, fallback: 0),
      "oldLines": group(2, fallback: 1),
      "newStart": group(3, fallback: 0),
      "newLines": group(4, fallback: 1)
    ]
  }

  /// `mapDiff` parity: attach staged/stageable flags and produce DiffFile JSON.
  public static func mapDiff(_ raw: String, stagedPaths: Set<String>, stageablePaths: Set<String>?) -> [JSONValue] {
    parse(raw).map { file in
      let current = file.to.isEmpty ? file.from : file.to
      return .object([
        "from": .string(file.from),
        "to": .string(file.to),
        "additions": .number(Double(file.additions)),
        "deletions": .number(Double(file.deletions)),
        "staged": .bool(stagedPaths.contains(current)),
        "stageable": .bool(stageablePaths?.contains(current) ?? true),
        "binary": .bool(file.binary),
        "chunks": .array(file.chunks)
      ])
    }
  }
}
