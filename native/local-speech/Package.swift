// swift-tools-version: 5.10
import PackageDescription
let package = Package(name: "LocalSpeech", platforms: [.macOS(.v14)], products: [.executable(name: "local-speech", targets: ["LocalSpeech"]), .library(name: "SpeechCore", targets: ["SpeechCore"])], dependencies: [.package(url: "https://github.com/argmaxinc/WhisperKit.git", exact: "1.1.0")], targets: [.target(name: "SpeechCore", dependencies: [.product(name: "WhisperKit", package: "WhisperKit")]), .executableTarget(name: "LocalSpeech", dependencies: ["SpeechCore"]), .testTarget(name: "LocalSpeechTests", dependencies: ["SpeechCore"])])
