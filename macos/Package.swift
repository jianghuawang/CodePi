// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CodePi",
  platforms: [.macOS(.v12)],
  targets: [
    .target(name: "CodePiKit"),
    .executableTarget(name: "CodePi", dependencies: ["CodePiKit"]),
    .testTarget(name: "CodePiKitTests", dependencies: ["CodePiKit"])
  ]
)
