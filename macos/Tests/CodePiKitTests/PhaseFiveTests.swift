import XCTest
@testable import CodePiKit

@MainActor
final class WorkspaceServiceTests: XCTestCase {
  private var root = ""

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-ws-\(UUID().uuidString)").path
    for directory in ["src", "node_modules/dep", ".git"] {
      try FileManager.default.createDirectory(atPath: root + "/" + directory, withIntermediateDirectories: true)
    }
    try "export {}\n".write(toFile: root + "/src/app.ts", atomically: true, encoding: .utf8)
    try "# readme\n".write(toFile: root + "/README.md", atomically: true, encoding: .utf8)
    try "ignored\n".write(toFile: root + "/node_modules/dep/index.js", atomically: true, encoding: .utf8)
    try Data([0x00, 0x01, 0x02, 0xFF]).write(to: URL(fileURLWithPath: root + "/blob.bin"))
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func testListsFilesSkippingIgnoredDirectories() throws {
    let service = WorkspaceService()
    let files = try service.listFiles(threadId: "t1", cwd: root).arrayValue!
    let paths = files.compactMap { $0.objectValue?["path"]?.stringValue }
    XCTAssertTrue(paths.contains("src/app.ts"))
    XCTAssertTrue(paths.contains("README.md"))
    XCTAssertFalse(paths.contains { $0.hasPrefix("node_modules") || $0.hasPrefix(".git") })
  }

  func testSearchRanksNameMatchesFirst() throws {
    let service = WorkspaceService()
    let results = try service.searchFiles(threadId: "t1", cwd: root, query: "app", limit: 10).arrayValue!
    XCTAssertEqual(results.first?.objectValue?["name"], .string("app.ts"))
  }

  func testReadFileDetectsLanguageAndBinary() throws {
    let service = WorkspaceService()
    let text = try service.readFile(cwd: root, relativePath: "src/app.ts").objectValue!
    XCTAssertEqual(text["language"], .string("typescript"))
    XCTAssertEqual(text["binary"], .bool(false))
    XCTAssertEqual(text["content"], .string("export {}\n"))
    let binary = try service.readFile(cwd: root, relativePath: "blob.bin").objectValue!
    XCTAssertEqual(binary["binary"], .bool(true))
    XCTAssertEqual(binary["content"], .string(""))
  }

  func testRejectsTraversal() {
    let service = WorkspaceService()
    XCTAssertThrowsError(try service.readFile(cwd: root, relativePath: "../etc/passwd"))
    XCTAssertThrowsError(try service.readFile(cwd: root, relativePath: "/etc/passwd"))
  }
}

@MainActor
final class TranscriptSearchTests: XCTestCase {
  func testTitleTagAndContentTiers() throws {
    let sessionFile = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-search-\(UUID().uuidString).jsonl").path
    let lines = [
      #"{"type":"session","id":"s1","cwd":"/tmp"}"#,
      #"{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"find the flux capacitor bug","timestamp":1000}}"#
    ]
    try (lines.joined(separator: "\n") + "\n").write(toFile: sessionFile, atomically: true, encoding: .utf8)
    let threads = [
      ThreadRecord(id: "t1", projectId: "p1", title: "Capacitor work", cwd: "/tmp", createdAt: 0, updatedAt: nowMilliseconds(), sessionFile: sessionFile, tags: ["hardware"]),
      ThreadRecord(id: "t2", projectId: "p1", title: "Other", cwd: "/tmp", createdAt: 0, updatedAt: nowMilliseconds())
    ]
    let search = TranscriptSearch()
    let byTitle = search.search(query: "capacitor", threads: threads, projectNames: [:]).arrayValue!
    XCTAssertEqual(byTitle.first?.objectValue?["threadId"], .string("t1"))
    // Both a title match and a transcript match surface for t1.
    XCTAssertEqual(byTitle.filter { $0.objectValue?["threadId"] == .string("t1") }.count, 2)
    let byContent = search.search(query: "flux", threads: threads, projectNames: [:]).arrayValue!
    XCTAssertEqual(byContent.count, 1)
    XCTAssertTrue(byContent[0].objectValue?["snippet"]?.stringValue?.contains("flux capacitor") == true)
    let byTag = search.search(query: "hardware", threads: threads, projectNames: [:]).arrayValue!
    XCTAssertEqual(byTag.first?.objectValue?["snippet"], .string("hardware"))
  }
}

final class ExportServiceTests: XCTestCase {
  private func fixtureMessages() throws -> [JSONValue] {
    [
      try JSONValue.parse(#"{"role":"user","content":"hello `world`","timestamp":1000}"#),
      try JSONValue.parse(#"""
      {"role":"assistant","model":"fake-1","timestamp":2000,
       "content":[{"type":"text","text":"<b>answer</b>"},{"type":"thinking","thinking":"hmm"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"cmd":"ls"}}],
       "usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.12}}}
      """#),
      try JSONValue.parse(#"{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"file.txt"}],"isError":false,"timestamp":3000}"#)
    ]
  }

  private var thread: ThreadRecord {
    ThreadRecord(id: "t1", projectId: "p1", title: "Export me", cwd: "/tmp/demo", createdAt: 0, updatedAt: 0)
  }

  func testMarkdownRender() throws {
    let markdown = ExportService.renderMarkdown(thread: thread, messages: try fixtureMessages(), projectName: "Demo")
    XCTAssertTrue(markdown.hasPrefix("# Export me"))
    XCTAssertTrue(markdown.contains("- Project: Demo"))
    XCTAssertTrue(markdown.contains("- Total tokens: 15"))
    XCTAssertTrue(markdown.contains("## Pi · fake-1"))
    XCTAssertTrue(markdown.contains("Tool call: bash"))
    XCTAssertTrue(markdown.contains("### Tool result: bash"))
    XCTAssertTrue(markdown.contains("$0.1200"))
  }

  func testHtmlRenderEscapes() throws {
    let html = ExportService.renderHtml(thread: thread, messages: try fixtureMessages(), projectName: "Demo")
    XCTAssertTrue(html.contains("&lt;b&gt;answer&lt;/b&gt;"))
    XCTAssertFalse(html.contains("<b>answer</b>"))
    XCTAssertTrue(html.contains("<title>Export me · CodePi export</title>"))
    XCTAssertTrue(html.contains("15 tokens"))
  }

  func testExportWritesFile() throws {
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-export-\(UUID().uuidString).md").path
    let path = try ExportService.export(
      thread: thread, messages: try fixtureMessages(), projectName: nil,
      format: "markdown", outputPath: output
    )
    XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    XCTAssertThrowsError(try ExportService.export(
      thread: thread, messages: [], projectName: nil, format: "pdf", outputPath: output
    ))
  }
}

final class PreviewPolicyTests: XCTestCase {
  func testAcceptsLoopbackAndNormalizes() throws {
    XCTAssertEqual(try PreviewPolicy.normalizeURL("localhost:3000").absoluteString, "http://localhost:3000")
    XCTAssertEqual(try PreviewPolicy.normalizeURL("http://0.0.0.0:8080/x").host, "127.0.0.1")
  }

  func testRejectsRemoteCredentialsAndSchemes() {
    XCTAssertThrowsError(try PreviewPolicy.normalizeURL("https://example.com"))
    XCTAssertThrowsError(try PreviewPolicy.normalizeURL("http://user:pw@localhost:3000"))
    XCTAssertThrowsError(try PreviewPolicy.normalizeURL("file:///etc/passwd"))
  }
}

final class CapabilityDiscoveryTests: XCTestCase {
  func testParsesPiListOutput() {
    let output = """
    User packages:
      npm:@acme/tools
        /Users/x/.pi/agent/npm/node_modules/@acme/tools
    Project packages:
      No packages
    """
    let roots = CapabilityDiscovery.parsePiListOutput(output)
    XCTAssertEqual(roots, [CapabilityDiscovery.PackageRoot(
      source: "npm:@acme/tools", scope: "user", path: "/Users/x/.pi/agent/npm/node_modules/@acme/tools"
    )])
  }

  func testGlobPatternsWithForceOverrides() {
    let paths = ["/base/a/one.ts", "/base/a/two.ts", "/base/b/three.ts"]
    let filtered = CapabilityDiscovery.applyPatterns(
      paths,
      patterns: ["a/*.ts", "!a/two.ts", "+b/three.ts"],
      baseDir: "/base",
      kind: "extension"
    )
    XCTAssertEqual(filtered, ["/base/a/one.ts", "/base/b/three.ts"])
  }

  func testDiscoversAutoResourcesAndBuildsSpawnArgs() async throws {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("codepi-cap-\(UUID().uuidString)").path
    let agent = home + "/.pi/agent"
    try FileManager.default.createDirectory(atPath: agent + "/extensions", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: agent + "/skills/greet", withIntermediateDirectories: true)
    try "export default {}\n".write(toFile: agent + "/extensions/hello.ts", atomically: true, encoding: .utf8)
    try "---\nname: greeter\ndescription: Says hi\n---\nBody\n"
      .write(toFile: agent + "/skills/greet/SKILL.md", atomically: true, encoding: .utf8)
    let cwd = home + "/project"
    try FileManager.default.createDirectory(atPath: cwd, withIntermediateDirectories: true)

    let settings = AppSettings(
      piPath: "/nonexistent/pi",
      env: ["HOME": home, "PI_CODING_AGENT_DIR": agent]
    )
    let thread = ThreadRecord(id: "t1", projectId: "p1", title: "T", cwd: cwd, createdAt: 0, updatedAt: 0)

    let list = await CapabilityDiscovery.list(thread: thread, settings: settings).arrayValue!
    XCTAssertEqual(list.count, 2)
    let skill = list.first { $0.objectValue?["kind"]?.stringValue == "skill" }!.objectValue!
    XCTAssertEqual(skill["name"], .string("greeter"))
    XCTAssertEqual(skill["description"], .string("Says hi"))
    XCTAssertEqual(skill["commandName"], .string("skill:greeter"))
    XCTAssertEqual(skill["source"], .string("user"))
    XCTAssertEqual(skill["enabled"], .bool(true))

    let args = await CapabilityDiscovery.buildSpawnArgs(thread: thread, settings: settings)
    XCTAssertEqual(Array(args.prefix(2)), ["--no-extensions", "--no-skills"])
    XCTAssertTrue(args.contains("--extension"))
    XCTAssertTrue(args.contains("--skill"))

    // Disabling the skill removes it from the spawn args but keeps it listed.
    let skillId = skill["id"]!.stringValue!
    var disabledThread = thread
    disabledThread.disabledCapabilityIds = [skillId]
    let disabledArgs = await CapabilityDiscovery.buildSpawnArgs(thread: disabledThread, settings: settings)
    XCTAssertFalse(disabledArgs.contains("--skill"))
    let disabledList = await CapabilityDiscovery.list(thread: disabledThread, settings: settings).arrayValue!
    let disabledSkill = disabledList.first { $0.objectValue?["kind"]?.stringValue == "skill" }!.objectValue!
    XCTAssertEqual(disabledSkill["enabled"], .bool(false))
  }
}
