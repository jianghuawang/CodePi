import Darwin
import Foundation

/// Native PTY backend replacing node-pty: `openpty(3)` + `posix_spawn` with
/// `POSIX_SPAWN_SETSID`, opening the slave in the child so the shell gets a
/// proper controlling terminal (job control works). Behavior mirrors
/// `terminal-service.ts`: per-session 16 ms output coalescing, 128 KB event
/// cap, SIGHUP→SIGKILL close sequence, and the same session limits.
@MainActor
public final class PtyService {
  public typealias EventSink = (JSONValue) -> Void

  private static let maxTerminalsPerThread = 6
  private static let maxTerminalsTotal = 24
  private static let maxInputBytes = 64 * 1024
  private static let maxEventCharacters = 128 * 1024
  // _IOW('t', 103, struct winsize) — not imported into Swift from <sys/ttycom.h>.
  private static let TIOCSWINSZ: UInt = 0x8008_7467

  private final class Session {
    let id: String
    let threadId: String
    let masterFD: Int32
    let pid: pid_t
    var readSource: DispatchSourceRead?
    var processSource: DispatchSourceProcess?
    var undecodedTail = Data()
    var pending = ""
    var flushScheduled = false
    var exited = false
    var closing = false

    init(id: String, threadId: String, masterFD: Int32, pid: pid_t) {
      self.id = id
      self.threadId = threadId
      self.masterFD = masterFD
      self.pid = pid
    }
  }

  private var sessions: [String: Session] = [:]
  private let emit: EventSink

  public init(emit: @escaping EventSink) {
    self.emit = emit
  }

  // MARK: - Launch options (terminal-platform.ts parity)

  public static func launchOptions(cwd: String) -> (shell: String, args: [String], env: [String: String]) {
    var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("ELECTRON_") }
    env["PWD"] = cwd
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["TERM_PROGRAM"] = "CodePi"
    env["TERM_PROGRAM_VERSION"] = env["TERM_PROGRAM_VERSION"] ?? "0.3.0"
    if env["LANG"]?.isEmpty != false { env["LANG"] = "en_US.UTF-8" }
    let configured = ProcessInfo.processInfo.environment["SHELL"]
    let shell = (configured?.hasPrefix("/") == true) ? configured! : "/bin/zsh"
    return (shell, ["-l"], env)
  }

  // MARK: - Public API

  public func open(threadId: String, cwd: String, columns: Int, rows: Int) throws -> String {
    let columns = try Self.dimension(columns, minimum: 2, maximum: 500, name: "columns")
    let rows = try Self.dimension(rows, minimum: 1, maximum: 300, name: "rows")
    let active = sessions.values.filter { !$0.exited }
    guard active.count < Self.maxTerminalsTotal else { throw BridgeError("Too many terminals are already open") }
    guard active.filter({ $0.threadId == threadId }).count < Self.maxTerminalsPerThread else {
      throw BridgeError("This thread already has the maximum number of terminals")
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw BridgeError("The thread working directory is unavailable")
    }

    var master: Int32 = -1
    var slave: Int32 = -1
    var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(columns), ws_xpixel: 0, ws_ypixel: 0)
    guard openpty(&master, &slave, nil, nil, &size) == 0 else {
      throw BridgeError("The integrated terminal could not allocate a PTY")
    }
    guard let slavePathC = ptsname(master) else {
      close(master)
      close(slave)
      throw BridgeError("The integrated terminal could not resolve its PTY name")
    }
    let slavePath = String(cString: slavePathC)

    let launch = Self.launchOptions(cwd: cwd)
    var fileActions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fileActions)
    posix_spawn_file_actions_addchdir_np(&fileActions, cwd)
    // Opened after SETSID, the slave becomes the controlling terminal.
    posix_spawn_file_actions_addopen(&fileActions, 0, slavePath, O_RDWR, 0)
    posix_spawn_file_actions_adddup2(&fileActions, 0, 1)
    posix_spawn_file_actions_adddup2(&fileActions, 0, 2)
    posix_spawn_file_actions_addclose(&fileActions, master)
    posix_spawn_file_actions_addclose(&fileActions, slave)
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))

    var argv: [UnsafeMutablePointer<CChar>?] = ([launch.shell] + launch.args).map { strdup($0) }
    argv.append(nil)
    var envp: [UnsafeMutablePointer<CChar>?] = launch.env.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)
    var pid: pid_t = 0
    let spawnResult = posix_spawn(&pid, launch.shell, &fileActions, &attributes, argv, envp)
    posix_spawn_file_actions_destroy(&fileActions)
    posix_spawnattr_destroy(&attributes)
    for pointer in argv where pointer != nil { free(pointer) }
    for pointer in envp where pointer != nil { free(pointer) }
    close(slave)
    guard spawnResult == 0 else {
      close(master)
      throw BridgeError("The integrated terminal could not start \(launch.shell): \(String(cString: strerror(spawnResult)))")
    }

    _ = fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK)
    let id = UUID().uuidString.lowercased()
    let session = Session(id: id, threadId: threadId, masterFD: master, pid: pid)
    sessions[id] = session
    attachSources(session)
    return id
  }

  public func write(terminalId: String, data: String) throws {
    guard data.utf8.count <= Self.maxInputBytes else { throw BridgeError("Terminal input is too large") }
    let session = try requireSession(terminalId)
    guard !session.exited, !session.closing else { throw BridgeError("Terminal has exited") }
    let bytes = Array(data.utf8)
    var offset = 0
    while offset < bytes.count {
      let written = bytes.withUnsafeBufferPointer { buffer in
        Darwin.write(session.masterFD, buffer.baseAddress! + offset, bytes.count - offset)
      }
      if written <= 0 {
        if errno == EAGAIN { usleep(2_000); continue }
        break
      }
      offset += written
    }
  }

  public func resize(terminalId: String, columns: Int, rows: Int) throws {
    let columns = try Self.dimension(columns, minimum: 2, maximum: 500, name: "columns")
    let rows = try Self.dimension(rows, minimum: 1, maximum: 300, name: "rows")
    let session = try requireSession(terminalId)
    guard !session.exited, !session.closing else { return }
    var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(columns), ws_xpixel: 0, ws_ypixel: 0)
    _ = ioctl(session.masterFD, Self.TIOCSWINSZ, &size)
  }

  public func closeTerminal(_ terminalId: String) async {
    guard let session = sessions[terminalId] else { return }
    await closeSession(session)
  }

  public func closeThread(_ threadId: String) async {
    for session in sessions.values.filter({ $0.threadId == threadId }) {
      await closeSession(session)
    }
  }

  public func stopAll() async {
    for session in Array(sessions.values) {
      await closeSession(session)
    }
  }

  // MARK: - Internals

  private static func dimension(_ value: Int, minimum: Int, maximum: Int, name: String) throws -> Int {
    guard value >= minimum, value <= maximum else {
      throw BridgeError("\(name) must be an integer from \(minimum) to \(maximum)")
    }
    return value
  }

  private func requireSession(_ terminalId: String) throws -> Session {
    guard let session = sessions[terminalId] else { throw BridgeError("Terminal not found") }
    return session
  }

  /// Both dispatch sources run on the main queue: the master fd is
  /// non-blocking, reads are cheap, and this keeps every handler inside the
  /// service's main-actor isolation (Swift 6 enforces this at runtime).
  private func attachSources(_ session: Session) {
    let read = DispatchSource.makeReadSource(fileDescriptor: session.masterFD, queue: .main)
    read.setEventHandler { [weak self, weak session] in
      guard let self, let session else { return }
      var chunk = Data()
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while true {
        let count = Darwin.read(session.masterFD, &buffer, buffer.count)
        if count > 0 {
          chunk.append(contentsOf: buffer[0..<count])
          if count == buffer.count { continue }
        }
        break
      }
      guard !chunk.isEmpty else { return }
      self.acceptOutput(session, chunk: chunk)
    }
    read.setCancelHandler { [fd = session.masterFD] in
      close(fd)
    }
    session.readSource = read
    read.resume()

    let exit = DispatchSource.makeProcessSource(identifier: session.pid, eventMask: .exit, queue: .main)
    exit.setEventHandler { [weak self, weak session] in
      guard let self, let session else { return }
      var status: Int32 = 0
      waitpid(session.pid, &status, 0)
      let exitCode = (status & 0x7F) == 0 ? (status >> 8) & 0xFF : 0
      let signalNumber = (status & 0x7F) != 0 ? Int(status & 0x7F) : nil
      self.acceptExit(session, exitCode: Int(exitCode), signal: signalNumber)
    }
    session.processSource = exit
    exit.resume()
  }

  private func acceptOutput(_ session: Session, chunk: Data) {
    guard sessions[session.id] === session else { return }
    var data = session.undecodedTail
    data.append(chunk)
    let (text, tail) = Self.decodeKeepingIncompleteTail(data)
    session.undecodedTail = tail
    guard !text.isEmpty else { return }
    session.pending += text
    if session.pending.count >= Self.maxEventCharacters {
      flush(session)
      return
    }
    guard !session.flushScheduled else { return }
    session.flushScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self, weak session] in
      MainActor.assumeIsolated {
        guard let self, let session else { return }
        session.flushScheduled = false
        self.flush(session)
      }
    }
  }

  /// Decode UTF-8 while holding back a trailing incomplete sequence so split
  /// code points never surface as replacement characters mid-stream.
  static func decodeKeepingIncompleteTail(_ data: Data) -> (text: String, tail: Data) {
    guard !data.isEmpty else { return ("", Data()) }
    let bytes = [UInt8](data)
    var holdback = 0
    for offset in 1...min(3, bytes.count) {
      let byte = bytes[bytes.count - offset]
      if byte & 0b1100_0000 == 0b1000_0000 { continue }
      let expected: Int
      if byte & 0b1000_0000 == 0 { expected = 1 }
      else if byte & 0b1110_0000 == 0b1100_0000 { expected = 2 }
      else if byte & 0b1111_0000 == 0b1110_0000 { expected = 3 }
      else if byte & 0b1111_1000 == 0b1111_0000 { expected = 4 }
      else { expected = 1 }
      if expected > offset { holdback = offset }
      break
    }
    let cut = bytes.count - holdback
    let text = String(decoding: bytes[0..<cut], as: UTF8.self)
    return (text, Data(bytes[cut...]))
  }

  private func flush(_ session: Session) {
    var pending = session.pending
    session.pending = ""
    while !pending.isEmpty {
      let piece = String(pending.prefix(Self.maxEventCharacters))
      pending = String(pending.dropFirst(piece.count))
      emit(.object([
        "type": .string("data"),
        "terminalId": .string(session.id),
        "threadId": .string(session.threadId),
        "data": .string(piece)
      ]))
    }
  }

  private func acceptExit(_ session: Session, exitCode: Int, signal: Int?) {
    guard !session.exited else { return }
    session.exited = true
    flush(session)
    var payload: [String: JSONValue] = [
      "type": .string("exit"),
      "terminalId": .string(session.id),
      "threadId": .string(session.threadId),
      "exitCode": .number(Double(exitCode))
    ]
    if let signal { payload["signal"] = .number(Double(signal)) }
    emit(.object(payload))
    // Keep the session record briefly so late close() calls stay graceful.
    DispatchQueue.main.asyncAfter(deadline: .now() + 300) { [weak self, weak session] in
      MainActor.assumeIsolated {
        guard let self, let session else { return }
        self.removeSession(session)
      }
    }
  }

  private func closeSession(_ session: Session) async {
    if !session.exited && !session.closing {
      session.closing = true
      kill(session.pid, SIGHUP)
      await waitForExit(session, timeout: 0.45)
      if !session.exited {
        kill(session.pid, SIGKILL)
        await waitForExit(session, timeout: 0.1)
      }
    }
    removeSession(session)
  }

  private func waitForExit(_ session: Session, timeout: TimeInterval) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !session.exited && Date() < deadline {
      try? await Task.sleep(nanoseconds: 25_000_000)
    }
  }

  private func removeSession(_ session: Session) {
    guard sessions[session.id] === session else { return }
    sessions.removeValue(forKey: session.id)
    session.processSource?.cancel()
    session.processSource = nil
    // Cancelling the read source closes the master fd via its cancel handler.
    session.readSource?.cancel()
    session.readSource = nil
  }
}
