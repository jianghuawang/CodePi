import Foundation

/// Port of `pi-validation.ts` and small process helpers shared by services.
public enum PiEnvironment {
  /// Merge app-managed env over the inherited environment and, on macOS,
  /// prepend Homebrew paths so GUI launches still find `pi` and `git`.
  public static func environmentForPi(_ env: [String: String]) -> [String: String] {
    var merged = ProcessInfo.processInfo.environment
    for (key, value) in env { merged[key] = value }
    if env["PATH"] == nil {
      let inherited = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
      var entries = ["/opt/homebrew/bin", "/usr/local/bin"] + inherited
      var seen = Set<String>()
      entries = entries.filter { !$0.isEmpty && seen.insert($0).inserted }
      merged["PATH"] = entries.joined(separator: ":")
    }
    return merged
  }

  public struct Validation: Sendable {
    public let available: Bool
    public let path: String
    public let version: String?
    public let error: String?

    public var payload: JSONValue {
      var object: [String: JSONValue] = ["available": .bool(available), "path": .string(path)]
      if let version { object["version"] = .string(version) }
      if let error { object["error"] = .string(error) }
      return .object(object)
    }
  }

  public static func validatePiBinary(path piPath: String, env: [String: String] = [:]) async -> Validation {
    if piPath.isEmpty || piPath.contains("\0") {
      return Validation(available: false, path: piPath, version: nil, error: "Choose a Pi executable.")
    }
    if (piPath.contains("/") || piPath.contains("\\")) && !piPath.hasPrefix("/") {
      return Validation(
        available: false,
        path: piPath,
        version: nil,
        error: "Use an absolute path for a Pi executable outside PATH."
      )
    }
    let result = await ProcessRunner.run(
      command: [piPath, "--version"],
      env: environmentForPi(env),
      timeout: 8
    )
    if result.status == 0 {
      let version = result.stdout
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: .newlines)
        .first ?? ""
      return Validation(available: true, path: piPath, version: version.isEmpty ? nil : version, error: nil)
    }
    let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
    return Validation(
      available: false,
      path: piPath,
      version: nil,
      error: detail.isEmpty
        ? "Pi was not found. Install @earendil-works/pi-coding-agent or choose its executable."
        : detail
    )
  }

  public static func isGitProject(_ path: String) async -> Bool {
    let result = await ProcessRunner.run(
      command: ["git", "-C", path, "rev-parse", "--is-inside-work-tree"],
      env: environmentForPi([:]),
      timeout: 8
    )
    return result.status == 0 && result.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
  }
}

/// Minimal `execFile` equivalent: run through /usr/bin/env so bare command
/// names resolve against the provided PATH, capture output, enforce a timeout.
public enum ProcessRunner {
  public struct Result: Sendable {
    public let status: Int32
    public let stdout: String
    public let stderr: String
  }

  public static func run(
    command: [String],
    cwd: String? = nil,
    env: [String: String],
    timeout: TimeInterval,
    stdin: String? = nil
  ) async -> Result {
    await withCheckedContinuation { continuation in
      let resume = OnceResumer(continuation)
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = command
      process.environment = env
      if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
      let stdout = Pipe()
      let stderr = Pipe()
      process.standardOutput = stdout
      process.standardError = stderr
      let stdinPipe: Pipe?
      if stdin != nil {
        stdinPipe = Pipe()
        process.standardInput = stdinPipe
      } else {
        stdinPipe = nil
        process.standardInput = FileHandle.nullDevice
      }
      process.terminationHandler = { finished in
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        resume.resume(Result(
          status: finished.terminationStatus,
          stdout: String(decoding: outData, as: UTF8.self),
          stderr: String(decoding: errData, as: UTF8.self)
        ))
      }
      do {
        try process.run()
      } catch {
        resume.resume(Result(status: 127, stdout: "", stderr: error.localizedDescription))
        return
      }
      if let stdin, let stdinPipe {
        DispatchQueue.global().async {
          try? stdinPipe.fileHandleForWriting.write(contentsOf: Data(stdin.utf8))
          try? stdinPipe.fileHandleForWriting.close()
        }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
        if process.isRunning { process.terminate() }
      }
    }
  }
}

private final class OnceResumer: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<ProcessRunner.Result, Never>?

  init(_ continuation: CheckedContinuation<ProcessRunner.Result, Never>) {
    self.continuation = continuation
  }

  func resume(_ value: ProcessRunner.Result) {
    lock.lock()
    let target = continuation
    continuation = nil
    lock.unlock()
    target?.resume(returning: value)
  }
}
