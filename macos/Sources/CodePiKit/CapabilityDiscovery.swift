import CryptoKit
import Foundation

/// Port of `pi-capabilities.ts`: resolve the extensions and skills Pi would
/// discover for a thread (auto directories, settings entries with +/-/!
/// patterns and globs, `pi list` packages with package.json manifests), then
/// layer CodePi's per-thread disable list on top and build deterministic
/// spawn args (`--no-extensions --no-skills --extension … --skill …`).
public enum CapabilityDiscovery {
  struct Candidate {
    let kind: String // "extension" | "skill"
    var path: String
    let source: String // project | settings | user | package
    var packageName: String?
    var description: String?
  }

  struct ResourceSettings {
    var extensions: [String] = []
    var skills: [String] = []
    var packages: [PackageSetting] = []
  }

  struct PackageSetting {
    let source: String
    let scope: String // user | project
    var extensions: [String]?
    var skills: [String]?
  }

  public struct PackageRoot: Sendable, Equatable {
    public let source: String
    public let scope: String
    public let path: String
  }

  static var fs: FileManager { FileManager.default }

  public static func capabilityId(kind: String, realPath: String) -> String {
    var data = Data(kind.utf8)
    data.append(0)
    data.append(Data(realPath.utf8))
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return "pi-capability:\(digest)"
  }

  static func expandPath(_ input: String, baseDir: String, home: String) -> String {
    let value = input.trimmingCharacters(in: .whitespaces)
    if value == "~" { return home }
    if value.hasPrefix("~/") { return home + "/" + String(value.dropFirst(2)) }
    if value.hasPrefix("~") { return home + "/" + String(value.dropFirst(1)) }
    if value.hasPrefix("/") { return URL(fileURLWithPath: value).standardizedFileURL.path }
    return URL(fileURLWithPath: baseDir).appendingPathComponent(value).standardizedFileURL.path
  }

  static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
  }

  static func pathType(_ path: String) -> String? {
    var isDirectory: ObjCBool = false
    guard fs.fileExists(atPath: path, isDirectory: &isDirectory) else { return nil }
    return isDirectory.boolValue ? "directory" : "file"
  }

  // MARK: - Glob patterns (+/-/! and * ? ** semantics)

  static func hasPattern(_ value: String) -> Bool {
    value.range(of: "^[!+-]", options: .regularExpression) != nil || value.contains("*") || value.contains("?")
  }

  static func globRegex(_ pattern: String) -> NSRegularExpression? {
    var normalized = pattern
    if normalized.hasPrefix("./") { normalized.removeFirst(2) }
    var source = "^"
    let characters = Array(normalized)
    var index = 0
    while index < characters.count {
      let character = characters[index]
      if character == "*" {
        if index + 1 < characters.count && characters[index + 1] == "*" {
          index += 1
          if index + 1 < characters.count && characters[index + 1] == "/" {
            index += 1
            source += "(?:.*/)?"
          } else {
            source += ".*"
          }
        } else {
          source += "[^/]*"
        }
      } else if character == "?" {
        source += "[^/]"
      } else {
        source += NSRegularExpression.escapedPattern(for: String(character))
      }
      index += 1
    }
    return try? NSRegularExpression(pattern: source + "$")
  }

  static func relativePath(from base: String, to path: String) -> String {
    let baseURL = URL(fileURLWithPath: base).standardizedFileURL.path
    let target = URL(fileURLWithPath: path).standardizedFileURL.path
    if target == baseURL { return "" }
    if target.hasPrefix(baseURL + "/") { return String(target.dropFirst(baseURL.count + 1)) }
    // Walk upward with .. segments for out-of-tree targets.
    var baseParts = baseURL.split(separator: "/").map(String.init)
    var targetParts = target.split(separator: "/").map(String.init)
    while !baseParts.isEmpty, !targetParts.isEmpty, baseParts[0] == targetParts[0] {
      baseParts.removeFirst()
      targetParts.removeFirst()
    }
    return (Array(repeating: "..", count: baseParts.count) + targetParts).joined(separator: "/")
  }

  static func patternTargets(_ path: String, baseDir: String, kind: String) -> [String] {
    let absolute = URL(fileURLWithPath: path).standardizedFileURL.path
    let name = (path as NSString).lastPathComponent
    var targets = [relativePath(from: baseDir, to: path), name, absolute]
    if kind == "skill" && name == "SKILL.md" {
      let parent = (path as NSString).deletingLastPathComponent
      targets += [
        relativePath(from: baseDir, to: parent),
        (parent as NSString).lastPathComponent,
        URL(fileURLWithPath: parent).standardizedFileURL.path
      ]
    }
    return targets
  }

  static func matches(_ path: String, pattern: String, baseDir: String, kind: String, exact: Bool) -> Bool {
    if exact {
      var normalized = pattern
      if normalized.hasPrefix("./") { normalized.removeFirst(2) }
      return patternTargets(path, baseDir: baseDir, kind: kind).contains { target in
        var candidate = target
        if candidate.hasPrefix("./") { candidate.removeFirst(2) }
        return candidate == normalized
      }
    }
    guard let regex = globRegex(pattern) else { return false }
    return patternTargets(path, baseDir: baseDir, kind: kind).contains { target in
      var candidate = target
      if candidate.hasPrefix("./") { candidate.removeFirst(2) }
      let range = NSRange(candidate.startIndex..., in: candidate)
      return regex.firstMatch(in: candidate, range: range) != nil
    }
  }

  static func applyPatterns(_ paths: [String], patterns: [String], baseDir: String, kind: String) -> [String] {
    let includes = patterns.filter { $0.range(of: "^[!+-]", options: .regularExpression) == nil }
    let excludes = patterns.filter { $0.hasPrefix("!") }.map { String($0.dropFirst()) }
    let forceIncludes = patterns.filter { $0.hasPrefix("+") }.map { String($0.dropFirst()) }
    let forceExcludes = patterns.filter { $0.hasPrefix("-") }.map { String($0.dropFirst()) }
    var selected = Set(
      includes.isEmpty
        ? paths
        : paths.filter { path in includes.contains { matches(path, pattern: $0, baseDir: baseDir, kind: kind, exact: false) } }
    )
    for path in paths {
      if excludes.contains(where: { matches(path, pattern: $0, baseDir: baseDir, kind: kind, exact: false) }) {
        selected.remove(path)
      }
      if forceIncludes.contains(where: { matches(path, pattern: $0, baseDir: baseDir, kind: kind, exact: true) }) {
        selected.insert(path)
      }
      if forceExcludes.contains(where: { matches(path, pattern: $0, baseDir: baseDir, kind: kind, exact: true) }) {
        selected.remove(path)
      }
    }
    return paths.filter { selected.contains($0) }
  }

  static func applyAutoOverrides(_ paths: [String], entries: [String], baseDir: String, kind: String) -> [String] {
    applyPatterns(paths, patterns: entries.filter { $0.range(of: "^[!+-]", options: .regularExpression) != nil }, baseDir: baseDir, kind: kind)
  }

  // MARK: - Settings and manifests

  static func readPiSettings(path: String, scope: String) -> ResourceSettings {
    guard let raw = try? String(contentsOfFile: path, encoding: .utf8),
          let value = try? JSONValue.parse(raw),
          let object = value.objectValue else { return ResourceSettings() }
    var settings = ResourceSettings()
    settings.extensions = (object["extensions"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    settings.skills = (object["skills"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    for item in object["packages"]?.arrayValue ?? [] {
      if let source = item.stringValue, !source.trimmingCharacters(in: .whitespaces).isEmpty {
        settings.packages.append(PackageSetting(source: source.trimmingCharacters(in: .whitespaces), scope: scope))
      } else if let record = item.objectValue, let source = record["source"]?.stringValue,
                !source.trimmingCharacters(in: .whitespaces).isEmpty {
        settings.packages.append(PackageSetting(
          source: source.trimmingCharacters(in: .whitespaces),
          scope: scope,
          extensions: record["extensions"]?.arrayValue.map { $0.compactMap(\.stringValue) },
          skills: record["skills"]?.arrayValue.map { $0.compactMap(\.stringValue) }
        ))
      }
    }
    return settings
  }

  struct PackageManifest {
    var name: String?
    var description: String?
    var extensions: [String]?
    var skills: [String]?
  }

  static func readPackageJson(root: String) -> PackageManifest? {
    guard let raw = try? String(contentsOfFile: root + "/package.json", encoding: .utf8),
          let value = try? JSONValue.parse(raw),
          let object = value.objectValue else { return nil }
    let pi = object["pi"]?.objectValue
    return PackageManifest(
      name: object["name"]?.stringValue,
      description: object["description"]?.stringValue,
      extensions: pi?["extensions"]?.arrayValue.map { $0.compactMap(\.stringValue) },
      skills: pi?["skills"]?.arrayValue.map { $0.compactMap(\.stringValue) }
    )
  }

  // MARK: - Resource collection

  static func listDirectory(_ path: String) -> [String] {
    (try? fs.contentsOfDirectory(atPath: path))?.sorted() ?? []
  }

  static func resolveExtensionDirectory(_ path: String) -> [String]? {
    if let manifest = readPackageJson(root: path), let entries = manifest.extensions {
      return collectManifestResources(root: path, kind: "extension", entries: entries)
    }
    for indexName in ["index.ts", "index.js"] {
      let candidate = path + "/" + indexName
      if fs.fileExists(atPath: candidate) { return [candidate] }
    }
    return nil
  }

  static func collectAutoExtensions(_ path: String) -> [String] {
    guard pathType(path) == "directory" else { return [] }
    if let own = resolveExtensionDirectory(path) { return own }
    var extensions: [String] = []
    for name in listDirectory(path) {
      if name.hasPrefix(".") || name == "node_modules" { continue }
      let candidate = path + "/" + name
      let type = pathType(candidate)
      if type == "file", ["ts", "js"].contains((name as NSString).pathExtension) {
        extensions.append(candidate)
      } else if type == "directory", let nested = resolveExtensionDirectory(candidate) {
        extensions.append(contentsOf: nested)
      }
    }
    return extensions
  }

  static func collectSkills(_ path: String, allowRootMarkdown: Bool, root: String? = nil, visited: inout Set<String>) -> [String] {
    guard pathType(path) == "directory" else { return [] }
    let rootPath = root ?? path
    let canonicalDirectory = canonical(path)
    guard visited.insert(canonicalDirectory).inserted else { return [] }
    let entries = listDirectory(path)
    if entries.contains("SKILL.md"), pathType(path + "/SKILL.md") == "file" {
      return [path + "/SKILL.md"]
    }
    var skills: [String] = []
    for name in entries {
      if name.hasPrefix(".") || name == "node_modules" { continue }
      let candidate = path + "/" + name
      let type = pathType(candidate)
      if type == "file", allowRootMarkdown, path == rootPath, (name as NSString).pathExtension == "md" {
        skills.append(candidate)
      } else if type == "directory" {
        skills.append(contentsOf: collectSkills(candidate, allowRootMarkdown: allowRootMarkdown, root: rootPath, visited: &visited))
      }
    }
    return skills
  }

  static func collectSkills(_ path: String, allowRootMarkdown: Bool) -> [String] {
    var visited = Set<String>()
    return collectSkills(path, allowRootMarkdown: allowRootMarkdown, root: nil, visited: &visited)
  }

  static func collectResourcePath(_ path: String, kind: String) -> [String] {
    switch pathType(path) {
    case "file": return [path]
    case "directory": return kind == "extension" ? collectAutoExtensions(path) : collectSkills(path, allowRootMarkdown: true)
    default: return []
    }
  }

  static func walkManifestCandidates(root: String, kind: String, path: String? = nil, visited: inout Set<String>) -> [String] {
    let directory = path ?? root
    guard pathType(directory) == "directory" else { return [] }
    guard visited.insert(canonical(directory)).inserted else { return [] }
    var files: [String] = []
    for name in listDirectory(directory) {
      if name.hasPrefix(".") || name == "node_modules" { continue }
      let candidate = directory + "/" + name
      let type = pathType(candidate)
      if type == "directory" {
        files.append(contentsOf: walkManifestCandidates(root: root, kind: kind, path: candidate, visited: &visited))
      } else if type == "file" {
        let ext = (name as NSString).pathExtension
        if kind == "extension" ? ["ts", "js"].contains(ext) : ext == "md" {
          files.append(candidate)
        }
      }
    }
    return files
  }

  static func collectManifestResources(root: String, kind: String, entries: [String]) -> [String] {
    let sourceEntries = entries.filter { $0.range(of: "^[!+-]", options: .regularExpression) == nil }
    var resources: [String] = []
    var manifestCandidates: [String]?
    for entry in sourceEntries {
      if entry.contains("*") || entry.contains("?") {
        if manifestCandidates == nil {
          var visited = Set<String>()
          manifestCandidates = walkManifestCandidates(root: root, kind: kind, visited: &visited)
        }
        resources.append(contentsOf: manifestCandidates!.filter {
          matches($0, pattern: entry, baseDir: root, kind: kind, exact: false)
        })
      } else {
        resources.append(contentsOf: collectResourcePath(
          URL(fileURLWithPath: root).appendingPathComponent(entry).standardizedFileURL.path,
          kind: kind
        ))
      }
    }
    var seen = Set<String>()
    let unique = resources
      .map { URL(fileURLWithPath: $0).standardizedFileURL.path }
      .filter { seen.insert($0).inserted }
    return applyPatterns(
      unique,
      patterns: entries.filter { $0.range(of: "^[!+-]", options: .regularExpression) != nil },
      baseDir: root,
      kind: kind
    )
  }

  static func collectSettingsResources(entries: [String], baseDir: String, home: String, kind: String, source: String) -> [Candidate] {
    var paths: [String] = []
    for entry in entries where !hasPattern(entry) {
      paths.append(contentsOf: collectResourcePath(expandPath(entry, baseDir: baseDir, home: home), kind: kind))
    }
    return applyPatterns(paths, patterns: entries.filter(hasPattern), baseDir: baseDir, kind: kind)
      .map { Candidate(kind: kind, path: $0, source: source) }
  }

  // MARK: - Packages

  static func stripTerminalEscapes(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\u{1B}\\][^\u{07}]*(?:\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
      .replacingOccurrences(of: "\u{1B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
  }

  public static func parsePiListOutput(_ output: String) -> [PackageRoot] {
    var roots: [PackageRoot] = []
    var scope: String?
    var source: String?
    for rawLine in stripTerminalEscapes(output).components(separatedBy: .newlines) {
      let line = rawLine.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty { continue }
      if trimmed.range(of: "^User packages:", options: [.regularExpression, .caseInsensitive]) != nil {
        scope = "user"
        source = nil
        continue
      }
      if trimmed.range(of: "^Project packages:", options: [.regularExpression, .caseInsensitive]) != nil {
        scope = "project"
        source = nil
        continue
      }
      guard let currentScope = scope,
            trimmed.range(of: "^(No packages|None\\.?$)", options: [.regularExpression, .caseInsensitive]) == nil
      else { continue }
      let indentation = line.count - line.drop(while: { $0 == " " || $0 == "\t" }).count
      if indentation <= 2 {
        source = trimmed
        continue
      }
      if let currentSource = source, indentation >= 4, trimmed.hasPrefix("/") {
        roots.append(PackageRoot(source: currentSource, scope: currentScope, path: URL(fileURLWithPath: trimmed).standardizedFileURL.path))
        source = nil
      }
    }
    return roots
  }

  static func npmPackageName(_ source: String) -> String? {
    let raw = source.hasPrefix("npm:") ? String(source.dropFirst(4)) : source
    if raw.isEmpty { return nil }
    if raw.range(of: "^(?:\\.|~|/)", options: .regularExpression) != nil { return nil }
    if raw.hasPrefix("@") {
      guard let slash = raw.firstIndex(of: "/") else { return nil }
      if let version = raw[raw.index(after: slash)...].firstIndex(of: "@") {
        return String(raw[..<version])
      }
      return raw
    }
    if let version = raw.lastIndex(of: "@"), version != raw.startIndex {
      return String(raw[..<version])
    }
    return raw
  }

  static func packageIdentity(_ setting: PackageSetting, baseDir: String, home: String) -> String {
    let npmName = npmPackageName(setting.source)
    let isRemote = setting.source.range(of: "^(?:git:|https?:|ssh:|git@)", options: .regularExpression) != nil
    if setting.source.hasPrefix("npm:") || (npmName != nil && !isRemote) {
      return "npm:\(npmName ?? setting.source)"
    }
    if isRemote {
      return "git:" + setting.source.replacingOccurrences(of: "@[^/@]+$", with: "", options: .regularExpression)
    }
    return "local:" + expandPath(setting.source, baseDir: baseDir, home: home)
  }

  static func findListedPackageRoot(_ setting: PackageSetting, roots: [PackageRoot], baseDir: String, home: String) -> String? {
    if let exact = roots.first(where: { $0.scope == setting.scope && $0.source == setting.source }) {
      return exact.path
    }
    let identity = packageIdentity(setting, baseDir: baseDir, home: home)
    if let equivalent = roots.first(where: {
      $0.scope == setting.scope
        && packageIdentity(PackageSetting(source: $0.source, scope: $0.scope), baseDir: baseDir, home: home) == identity
    }) {
      return equivalent.path
    }
    if setting.source.range(of: "^(?:\\.|~|/)", options: .regularExpression) != nil {
      return expandPath(setting.source, baseDir: baseDir, home: home)
    }
    if setting.scope == "project", let npmName = npmPackageName(setting.source) {
      return baseDir + "/npm/node_modules/" + npmName
    }
    return nil
  }

  static func collectPackageResources(root: String, setting: PackageSetting) -> [Candidate] {
    guard let type = pathType(root) else { return [] }
    let manifest = type == "directory" ? readPackageJson(root: root) : nil
    let packageName = manifest?.name ?? setting.source
    var candidates: [Candidate] = []
    for kind in ["extension", "skill"] {
      let configuredFilter = kind == "extension" ? setting.extensions : setting.skills
      if configuredFilter?.isEmpty == true { continue }
      var paths: [String]
      if type == "file" {
        paths = kind == "extension" ? [root] : []
      } else if let manifestEntries = kind == "extension" ? manifest?.extensions : manifest?.skills {
        paths = collectManifestResources(root: root, kind: kind, entries: manifestEntries)
      } else {
        paths = collectResourcePath(root + "/" + (kind == "extension" ? "extensions" : "skills"), kind: kind)
      }
      if let configuredFilter {
        paths = applyPatterns(paths, patterns: configuredFilter, baseDir: root, kind: kind)
      }
      candidates.append(contentsOf: paths.map {
        Candidate(kind: kind, path: $0, source: "package", packageName: packageName,
                  description: kind == "extension" ? manifest?.description : nil)
      })
    }
    return candidates
  }

  // MARK: - Skill metadata and assembly

  static func skillMetadata(path: String) -> (name: String?, description: String?) {
    guard let content = try? String(contentsOfFile: path, encoding: .utf8).prefix(64 * 1024),
          content.hasPrefix("---"),
          let end = content.range(of: "\n---", range: content.index(content.startIndex, offsetBy: 3)..<content.endIndex)
    else { return (nil, nil) }
    let header = String(content[content.index(content.startIndex, offsetBy: 3)..<end.lowerBound])
    func field(_ key: String) -> String? {
      guard let regex = try? NSRegularExpression(pattern: "^\(key):[ \\t]*(.+)$", options: .anchorsMatchLines),
            let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
            let range = Range(match.range(at: 1), in: header)
      else { return nil }
      var value = String(header[range]).trimmingCharacters(in: .whitespaces)
      if value.count >= 2,
         (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
        value = String(value.dropFirst().dropLast())
      }
      return value
    }
    let description = field("description")
    return (field("name"), description == ">" || description == "|" ? nil : description)
  }

  static func toCapability(_ candidate: Candidate, disabled: Set<String>) -> JSONValue {
    let path = canonical(candidate.path)
    let id = capabilityId(kind: candidate.kind, realPath: path)
    let metadata = candidate.kind == "skill" ? skillMetadata(path: path) : (name: nil, description: nil)
    let baseName = (path as NSString).lastPathComponent
    let fallbackName = baseName == "SKILL.md"
      ? ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
      : (baseName as NSString).deletingPathExtension
    let trimmedName = metadata.name?.trimmingCharacters(in: .whitespaces)
    let name = trimmedName?.isEmpty == false ? trimmedName! : fallbackName
    var object: [String: JSONValue] = [
      "id": .string(id),
      "kind": .string(candidate.kind),
      "name": .string(name),
      "path": .string(path),
      "source": .string(candidate.source),
      "enabled": .bool(!disabled.contains(id))
    ]
    if let description = metadata.description ?? candidate.description { object["description"] = .string(description) }
    if let packageName = candidate.packageName { object["packageName"] = .string(packageName) }
    if candidate.kind == "skill" { object["commandName"] = .string("skill:\(name)") }
    return .object(object)
  }

  static func findGitRoot(_ cwd: String) -> String? {
    var current = URL(fileURLWithPath: cwd).standardizedFileURL.path
    while true {
      if fs.fileExists(atPath: current + "/.git") { return current }
      let parent = (current as NSString).deletingLastPathComponent
      if parent == current { return nil }
      current = parent
    }
  }

  static func projectAgentSkillDirs(cwd: String, userAgentSkills: String) -> [String] {
    var directories: [String] = []
    let gitRoot = findGitRoot(cwd)
    var current = URL(fileURLWithPath: cwd).standardizedFileURL.path
    while true {
      let candidate = current + "/.agents/skills"
      if URL(fileURLWithPath: candidate).standardizedFileURL.path
        != URL(fileURLWithPath: userAgentSkills).standardizedFileURL.path {
        directories.append(candidate)
      }
      let parent = (current as NSString).deletingLastPathComponent
      if (gitRoot != nil && current == gitRoot!) || (gitRoot == nil && parent == current) { break }
      current = parent
    }
    return directories
  }

  // MARK: - Entry points

  static func resolve(thread: ThreadRecord, settings: AppSettings) async -> [Candidate] {
    let env = PiEnvironment.environmentForPi(settings.env)
    let home = env["HOME"] ?? fs.homeDirectoryForCurrentUser.path
    let agentDir = expandPath(env["PI_CODING_AGENT_DIR"] ?? home + "/.pi/agent", baseDir: thread.cwd, home: home)
    let projectBase = thread.cwd + "/.pi"

    let globalSettings = readPiSettings(path: agentDir + "/settings.json", scope: "user")
    let projectSettings = readPiSettings(path: projectBase + "/settings.json", scope: "project")
    let listResult = await ProcessRunner.run(
      command: [settings.piPath, "list"],
      cwd: thread.cwd,
      env: env,
      timeout: 8
    )
    let listedRoots = listResult.status == 0 ? parsePiListOutput(listResult.stdout) : []

    let userAgentSkills = home + "/.agents/skills"
    let ancestorSkillDirs = projectAgentSkillDirs(cwd: thread.cwd, userAgentSkills: userAgentSkills)

    let projectExtensions = applyAutoOverrides(
      collectAutoExtensions(projectBase + "/extensions"),
      entries: projectSettings.extensions, baseDir: projectBase, kind: "extension"
    )
    let projectSkills = applyAutoOverrides(
      collectSkills(projectBase + "/skills", allowRootMarkdown: true)
        + ancestorSkillDirs.flatMap { collectSkills($0, allowRootMarkdown: false) },
      entries: projectSettings.skills, baseDir: projectBase, kind: "skill"
    )
    let userExtensions = applyAutoOverrides(
      collectAutoExtensions(agentDir + "/extensions"),
      entries: globalSettings.extensions, baseDir: agentDir, kind: "extension"
    )
    let userSkills = applyAutoOverrides(
      collectSkills(agentDir + "/skills", allowRootMarkdown: true)
        + collectSkills(userAgentSkills, allowRootMarkdown: false),
      entries: globalSettings.skills, baseDir: agentDir, kind: "skill"
    )

    var packageSettings: [PackageSetting] = []
    var seenPackages = Set<String>()
    for setting in projectSettings.packages + globalSettings.packages {
      let base = setting.scope == "project" ? projectBase : agentDir
      let identity = packageIdentity(setting, baseDir: base, home: home)
      if seenPackages.insert(identity).inserted { packageSettings.append(setting) }
    }
    var packageCandidates: [Candidate] = []
    for setting in packageSettings {
      let base = setting.scope == "project" ? projectBase : agentDir
      if let root = findListedPackageRoot(setting, roots: listedRoots, baseDir: base, home: home) {
        packageCandidates.append(contentsOf: collectPackageResources(root: root, setting: setting))
      }
    }

    // Pi's documented collision precedence: project settings, project auto,
    // user settings, user auto, then package resources.
    let ordered =
      collectSettingsResources(entries: projectSettings.extensions, baseDir: projectBase, home: home, kind: "extension", source: "settings")
      + collectSettingsResources(entries: projectSettings.skills, baseDir: projectBase, home: home, kind: "skill", source: "settings")
      + projectExtensions.map { Candidate(kind: "extension", path: $0, source: "project") }
      + projectSkills.map { Candidate(kind: "skill", path: $0, source: "project") }
      + collectSettingsResources(entries: globalSettings.extensions, baseDir: agentDir, home: home, kind: "extension", source: "settings")
      + collectSettingsResources(entries: globalSettings.skills, baseDir: agentDir, home: home, kind: "skill", source: "settings")
      + userExtensions.map { Candidate(kind: "extension", path: $0, source: "user") }
      + userSkills.map { Candidate(kind: "skill", path: $0, source: "user") }
      + packageCandidates

    var unique: [String: Candidate] = [:]
    var order: [String] = []
    for candidate in ordered {
      let path = canonical(candidate.path)
      let key = "\(candidate.kind)\0\(path)"
      if unique[key] == nil {
        var stored = candidate
        stored.path = path
        unique[key] = stored
        order.append(key)
      }
    }
    return order.compactMap { unique[$0] }
  }

  public static func list(thread: ThreadRecord, settings: AppSettings) async -> JSONValue {
    let disabled = Set(thread.disabledCapabilityIds)
    let sourceOrder = ["project": 0, "settings": 1, "user": 2, "package": 3]
    let capabilities = await resolve(thread: thread, settings: settings)
      .map { toCapability($0, disabled: disabled) }
      .sorted { left, right in
        let leftObject = left.objectValue ?? [:]
        let rightObject = right.objectValue ?? [:]
        let kindOrder = (leftObject["kind"]?.stringValue ?? "").compare(rightObject["kind"]?.stringValue ?? "")
        if kindOrder != .orderedSame { return kindOrder == .orderedAscending }
        let leftSource = sourceOrder[leftObject["source"]?.stringValue ?? ""] ?? 9
        let rightSource = sourceOrder[rightObject["source"]?.stringValue ?? ""] ?? 9
        if leftSource != rightSource { return leftSource < rightSource }
        let nameOrder = (leftObject["name"]?.stringValue ?? "").compare(rightObject["name"]?.stringValue ?? "")
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return (leftObject["path"]?.stringValue ?? "") < (rightObject["path"]?.stringValue ?? "")
      }
    return .array(capabilities)
  }

  /// Deterministic Pi CLI args opting out of discovery and opting in explicitly.
  public static func buildSpawnArgs(thread: ThreadRecord, settings: AppSettings) async -> [String] {
    let disabled = Set(thread.disabledCapabilityIds)
    var args = ["--no-extensions", "--no-skills"]
    for candidate in await resolve(thread: thread, settings: settings) {
      let id = capabilityId(kind: candidate.kind, realPath: candidate.path)
      guard !disabled.contains(id) else { continue }
      args.append(candidate.kind == "extension" ? "--extension" : "--skill")
      args.append(candidate.path)
    }
    return args
  }

  /// Preserve stale disable entries while disabling every discovered
  /// capability, for the safe-restart path.
  public static func disabledIdsForSafeRestart(existing: [String], capabilities: JSONValue) -> [String] {
    var result = existing
    var seen = Set(existing)
    for capability in capabilities.arrayValue ?? [] {
      if let id = capability.objectValue?["id"]?.stringValue, seen.insert(id).inserted {
        result.append(id)
      }
    }
    return result
  }
}
