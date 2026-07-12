import Foundation

/// Port of `export-service.ts`: self-contained Markdown/HTML transcript
/// exports rendered from raw session messages (never renderer-bounded ones).
public enum ExportService {
  struct Usage {
    var turns = 0
    var input = 0.0
    var output = 0.0
    var cacheRead = 0.0
    var cacheWrite = 0.0
    var cost = 0.0
    var total: Double { input + output + cacheRead + cacheWrite }
  }

  static func aggregateUsage(_ messages: [JSONValue]) -> Usage {
    var usage = Usage()
    for message in messages {
      guard let object = message.objectValue,
            object["role"]?.stringValue == "assistant",
            let raw = object["usage"]?.objectValue else { continue }
      usage.turns += 1
      usage.input += raw["input"]?.numberValue ?? 0
      usage.output += raw["output"]?.numberValue ?? 0
      usage.cacheRead += raw["cacheRead"]?.numberValue ?? 0
      usage.cacheWrite += raw["cacheWrite"]?.numberValue ?? 0
      if let cost = raw["cost"]?.objectValue {
        if let total = cost["total"]?.numberValue {
          usage.cost += max(0, total)
        } else {
          usage.cost += [cost["input"], cost["output"], cost["cacheRead"], cost["cacheWrite"]]
            .compactMap { $0?.numberValue }.map { max(0, $0) }.reduce(0, +)
        }
      }
    }
    return usage
  }

  static func timestampText(_ value: JSONValue?) -> String {
    guard let milliseconds = value?.numberValue else { return "Unknown time" }
    return ISO8601DateFormatter.export.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
  }

  static func contentText(_ content: JSONValue?) -> String {
    if let text = content?.stringValue { return text }
    return (content?.arrayValue ?? []).compactMap { part -> String? in
      guard let object = part.objectValue else { return nil }
      if object["type"]?.stringValue == "text" { return object["text"]?.stringValue }
      if object["type"]?.stringValue == "image" {
        return "[Image: \(object["mimeType"]?.stringValue ?? "image")]"
      }
      return nil
    }.filter { !$0.isEmpty }.joined(separator: "\n")
  }

  static func fenced(_ value: String, language: String = "") -> String {
    var longest = 0
    var run = 0
    for character in value {
      run = character == "`" ? run + 1 : 0
      longest = max(longest, run)
    }
    let fence = String(repeating: "`", count: max(3, longest + 1))
    return "\(fence)\(language)\n\(value)\n\(fence)"
  }

  static func usageLine(_ message: [String: JSONValue]) -> String? {
    guard let usage = message["usage"]?.objectValue else { return nil }
    let input = usage["input"]?.numberValue ?? 0
    let output = usage["output"]?.numberValue ?? 0
    let total = input + output + (usage["cacheRead"]?.numberValue ?? 0) + (usage["cacheWrite"]?.numberValue ?? 0)
    var line = "Usage: \(grouped(total)) tokens (\(grouped(input)) input, \(grouped(output)) output)"
    if let cost = usage["cost"]?.objectValue?["total"]?.numberValue {
      line += String(format: " · $%.4f", cost)
    }
    return line
  }

  static func grouped(_ value: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: NSNumber(value: value)) ?? String(Int(value))
  }

  // MARK: - Markdown

  public static func renderMarkdown(thread: ThreadRecord, messages: [JSONValue], projectName: String?) -> String {
    let usage = aggregateUsage(messages)
    var header = [
      "# \(thread.title)",
      "",
      "- Exported: \(ISO8601DateFormatter.export.string(from: Date()))",
      "- Working directory: `\(thread.cwd.replacingOccurrences(of: "`", with: "\\`"))`"
    ]
    if let projectName { header.append("- Project: \(projectName)") }
    header += [
      "- Turns with usage: \(usage.turns)",
      "- Total tokens: \(grouped(usage.total))",
      String(format: "- Total reported cost: $%.4f", usage.cost),
      "",
      "---",
      ""
    ]
    let body = messages.compactMap(markdownMessage).joined(separator: "\n---\n\n")
    return header.joined(separator: "\n") + body + (body.isEmpty ? "" : "\n")
  }

  static func markdownMessage(_ value: JSONValue) -> String? {
    guard let message = value.objectValue else { return nil }
    let timestamp = timestampText(message["timestamp"])
    switch message["role"]?.stringValue {
    case "user":
      let text = contentText(message["content"])
      return "## You\n\n_\(timestamp)_\n\n\(text.isEmpty ? "_No text content_" : text)\n"
    case "assistant":
      let model = message["model"]?.stringValue
      var sections = ["## Pi\(model.map { " · \($0)" } ?? "")\n\n_\(timestamp)_"]
      for part in message["content"]?.arrayValue ?? [] {
        guard let object = part.objectValue else { continue }
        switch object["type"]?.stringValue {
        case "text":
          if let text = object["text"]?.stringValue { sections.append(text) }
        case "thinking":
          if let thinking = object["thinking"]?.stringValue {
            sections.append("<details>\n<summary>Thinking</summary>\n\n\(thinking)\n\n</details>")
          }
        case "toolCall":
          let name = object["name"]?.stringValue ?? "tool"
          let args = object["arguments"]?.prettyJSONString() ?? "{}"
          sections.append("<details>\n<summary>Tool call: \(name)</summary>\n\n\(fenced(args, language: "json"))\n\n</details>")
        default: break
        }
      }
      if let usage = usageLine(message) { sections.append("_\(usage)_") }
      if let error = message["errorMessage"]?.stringValue { sections.append("**Error:** \(error)") }
      return sections.joined(separator: "\n\n") + "\n"
    case "toolResult":
      let name = message["toolName"]?.stringValue ?? "tool"
      let isError = message["isError"]?.boolValue == true
      let body = (message["content"]?.arrayValue ?? []).compactMap { $0.objectValue?["text"]?.stringValue }.joined(separator: "\n")
      return "### Tool result: \(name)\(isError ? " (error)" : "")\n\n_\(timestamp)_\n\n\(fenced(body, language: "text"))\n"
    case "bashExecution":
      let exitCode = message["exitCode"]?.numberValue
      let command = message["command"]?.stringValue ?? ""
      let output = message["output"]?.stringValue ?? ""
      return "### Shell command\(exitCode.map { " · exit \(Int($0))" } ?? "")\n\n_\(timestamp)_\n\n\(fenced(command, language: "shell"))\n\n\(fenced(output, language: "text"))\n"
    case "custom":
      guard message["display"]?.boolValue == true else { return nil }
      let type = message["customType"]?.stringValue ?? "Extension"
      return "### \(type)\n\n_\(timestamp)_\n\n\(contentText(message["content"]))\n"
    case "branchSummary":
      return "<details>\n<summary>Branch context · \(timestamp)</summary>\n\n\(message["summary"]?.stringValue ?? "")\n\n</details>\n"
    case "compactionSummary":
      return "<details>\n<summary>Compacted context · \(timestamp)</summary>\n\n\(message["summary"]?.stringValue ?? "")\n\n</details>\n"
    default:
      return nil
    }
  }

  // MARK: - HTML

  static func escapeHtml(_ value: String) -> String {
    value
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&#39;")
  }

  static func htmlText(_ value: String) -> String {
    "<pre class=\"content\">\(escapeHtml(value))</pre>"
  }

  static func htmlDetails(_ summary: String, _ body: String, className: String = "") -> String {
    "<details\(className.isEmpty ? "" : " class=\"\(className)\"")><summary>\(escapeHtml(summary))</summary>\(body)</details>"
  }

  static func htmlMessage(_ value: JSONValue) -> String? {
    guard let message = value.objectValue else { return nil }
    let timestamp = escapeHtml(timestampText(message["timestamp"]))
    switch message["role"]?.stringValue {
    case "user":
      let text = contentText(message["content"])
      return "<section class=\"message user\"><header><h2>You</h2><time>\(timestamp)</time></header>\(htmlText(text.isEmpty ? "No text content" : text))</section>"
    case "assistant":
      var blocks: [String] = []
      for part in message["content"]?.arrayValue ?? [] {
        guard let object = part.objectValue else { continue }
        switch object["type"]?.stringValue {
        case "text":
          if let text = object["text"]?.stringValue { blocks.append(htmlText(text)) }
        case "thinking":
          if let thinking = object["thinking"]?.stringValue {
            blocks.append(htmlDetails("Thinking", htmlText(thinking), className: "thinking"))
          }
        case "toolCall":
          let name = object["name"]?.stringValue ?? "tool"
          blocks.append(htmlDetails("Tool call: \(name)", htmlText(object["arguments"]?.prettyJSONString() ?? "{}"), className: "tool"))
        default: break
        }
      }
      var footer = ""
      if let usage = usageLine(message) { footer += "<div class=\"usage\">\(escapeHtml(usage))</div>" }
      if let error = message["errorMessage"]?.stringValue { footer += "<div class=\"error\">\(escapeHtml(error))</div>" }
      let model = message["model"]?.stringValue.map { " · \(escapeHtml($0))" } ?? ""
      return "<section class=\"message assistant\"><header><h2>Pi\(model)</h2><time>\(timestamp)</time></header>\(blocks.joined())\(footer)</section>"
    case "toolResult":
      let name = escapeHtml(message["toolName"]?.stringValue ?? "tool")
      let isError = message["isError"]?.boolValue == true
      let body = (message["content"]?.arrayValue ?? []).compactMap { $0.objectValue?["text"]?.stringValue }.joined(separator: "\n")
      return "<section class=\"message tool-result\(isError ? " error-result" : "")\"><header><h2>Tool result · \(name)</h2><time>\(timestamp)</time></header>\(htmlText(body))</section>"
    case "bashExecution":
      let exitCode = message["exitCode"]?.numberValue.map { " · exit \(Int($0))" } ?? ""
      return "<section class=\"message tool-result\"><header><h2>Shell command\(exitCode)</h2><time>\(timestamp)</time></header>\(htmlDetails("Command", htmlText(message["command"]?.stringValue ?? ""), className: "tool"))\(htmlText(message["output"]?.stringValue ?? ""))</section>"
    case "custom":
      guard message["display"]?.boolValue == true else { return nil }
      let type = escapeHtml(message["customType"]?.stringValue ?? "Extension")
      return "<section class=\"message custom\"><header><h2>\(type)</h2><time>\(timestamp)</time></header>\(htmlText(contentText(message["content"])))</section>"
    case "branchSummary":
      return "<section class=\"message summary\">\(htmlDetails("Branch context · \(timestampText(message["timestamp"]))", htmlText(message["summary"]?.stringValue ?? "")))</section>"
    case "compactionSummary":
      return "<section class=\"message summary\">\(htmlDetails("Compacted context · \(timestampText(message["timestamp"]))", htmlText(message["summary"]?.stringValue ?? "")))</section>"
    default:
      return nil
    }
  }

  public static func renderHtml(thread: ThreadRecord, messages: [JSONValue], projectName: String?) -> String {
    let usage = aggregateUsage(messages)
    let body = messages.compactMap(htmlMessage).joined(separator: "\n")
    let title = escapeHtml(thread.title)
    let project = projectName.map { "<span>\(escapeHtml($0))</span>" } ?? ""
    let style = """
    :root{color-scheme:light dark;--bg:#fbfbfc;--surface:#fff;--muted:#6e6e73;--text:#1d1d1f;--border:rgba(0,0,0,.12);--tool:#f4f4f5;--accent:#0a6ee8;--error:#c93129} @media(prefers-color-scheme:dark){:root{--bg:#1d1d1f;--surface:#262628;--muted:#a1a1a6;--text:#f5f5f7;--border:rgba(255,255,255,.13);--tool:#2c2c2e;--accent:#58a9ff;--error:#ff6961}} *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif} main{width:min(860px,calc(100% - 40px));margin:42px auto 80px} .document-header{padding-bottom:24px;border-bottom:1px solid var(--border)} h1{margin:0;font-size:28px;letter-spacing:-.025em} .meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;color:var(--muted);font-size:12px} .message{padding:24px 0;border-bottom:1px solid var(--border)} header{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:10px} h2{margin:0;font-size:13px} time{color:var(--muted);font-size:11px} .content{margin:0 0 12px;padding:0;overflow:auto;background:transparent;color:inherit;font:13px/1.6 "SF Mono",ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word} details{margin:10px 0;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--tool)} summary{color:var(--muted);cursor:pointer;font-size:12px} details .content{margin:9px 0 0;font-size:12px} .user{margin-left:auto;width:min(82%,680px);padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface)} .assistant+.assistant{padding-top:12px} .tool-result{padding:15px;margin:14px 0;border:1px solid var(--border);border-radius:8px;background:var(--tool)} .usage{margin-top:10px;color:var(--muted);font-size:11px}.error,.error-result h2{color:var(--error)} .summary{border-bottom:0;padding:8px 0}
    """
    return """
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>\(title) · CodePi export</title>
    <style>
    \(style)
    </style>
    </head>
    <body>
    <main>
    <section class="document-header"><h1>\(title)</h1><div class="meta">\(project)<span>\(escapeHtml(thread.cwd))</span><span>\(grouped(usage.total)) tokens</span><span>\(String(format: "$%.4f", usage.cost))</span><span>Exported \(escapeHtml(ISO8601DateFormatter.export.string(from: Date())))</span></div></section>
    \(body)
    </main>
    </body>
    </html>

    """
  }

  public static func export(thread: ThreadRecord, messages: [JSONValue], projectName: String?, format: String, outputPath: String) throws -> String {
    guard !outputPath.contains("\0"), !outputPath.trimmingCharacters(in: .whitespaces).isEmpty else {
      throw BridgeError("Export path is invalid")
    }
    guard format == "markdown" || format == "html" else { throw BridgeError("Export format is invalid") }
    let content = format == "markdown"
      ? renderMarkdown(thread: thread, messages: messages, projectName: projectName)
      : renderHtml(thread: thread, messages: messages, projectName: projectName)
    let resolved = URL(fileURLWithPath: outputPath).standardizedFileURL
    try Data(content.utf8).write(to: resolved)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: resolved.path)
    return resolved.path
  }
}

extension ISO8601DateFormatter {
  static var export: ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }
}
