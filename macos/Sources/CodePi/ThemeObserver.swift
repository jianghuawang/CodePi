import AppKit

/// Watches the effective appearance and reports 'light'/'dark' — the Swift
/// counterpart of Electron's nativeTheme 'updated' event.
@MainActor
final class ThemeObserver {
  private var observation: NSKeyValueObservation?
  private let onChange: @MainActor (String) -> Void

  init(onChange: @escaping @MainActor (String) -> Void) {
    self.onChange = onChange
    observation = NSApp.observe(\.effectiveAppearance) { _, _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          onChange(Self.currentTheme())
        }
      }
    }
  }

  static func currentTheme() -> String {
    let appearance = NSApp.effectiveAppearance
    let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    return isDark ? "dark" : "light"
  }
}
