// Token conversion adapted from Argmax WhisperKit 1.1.0 (MIT).
import Foundation
import NaturalLanguage
import WhisperKit

final class LocalTokenizer: WhisperTokenizer {
  let tokenizer: TokenizerWrapper
  let tokenizerFolder: URL?
  public let specialTokens: SpecialTokens
  public let allLanguageTokens: Set<Int>

  public func encode(text: String) -> [Int] {
    tokenizer.encode(text: text)
  }

  public func decode(tokens: [Int]) -> String {
    tokenizer.decode(tokens: tokens)
  }

  public func convertTokenToId(_ token: String) -> Int? {
    tokenizer.convertTokenToId(token)
  }

  public func convertIdToToken(_ id: Int) -> String? {
    tokenizer.convertIdToToken(id)
  }

  /// Initializes a WhisperTokenizer wrapper with the provided tokenizer and optional folder location.
  ///
  /// This initializer sets up the tokenizer wrapper with special tokens and language token mappings
  /// required for Whisper decoding. The tokenizer folder parameter is stored for reference
  /// but does not affect the tokenizer's functionality.
  ///
  /// - Parameters:
  ///   - tokenizer: The underlying tokenizer implementation that handles text encoding/decoding
  ///   - tokenizerFolder: Optional URL representing the folder location where the tokenizer
  ///     files are stored. This is kept for reference purposes only and does not influence
  ///     tokenizer behavior or operations.
  ///
  /// - Note: Special tokens are automatically detected from the tokenizer vocabulary, with
  ///   fallback to default values if tokens are not found. Language tokens are identified
  ///   by matching the pattern `<|language|>` against the tokenizer's vocabulary.
  init(_ tokenizer: TokenizerWrapper, at tokenizerFolder: URL? = nil) {
    let specialTokens = SpecialTokens(
      endToken: tokenizer.convertTokenToId("<|endoftext|>") ?? Self.defaultEndToken,
      englishToken: tokenizer.convertTokenToId("<|en|>") ?? Self.defaultEnglishToken,
      noSpeechToken: tokenizer.convertTokenToId("<|nospeech|>") ?? Self.defaultNoSpeechToken,
      noTimestampsToken: tokenizer.convertTokenToId("<|notimestamps|>")
        ?? Self.defaultNoTimestampsToken,
      specialTokenBegin: tokenizer.convertTokenToId("<|endoftext|>")
        ?? Self.defaultSpecialTokenBegin,
      startOfPreviousToken: tokenizer.convertTokenToId("<|startofprev|>")
        ?? Self.defaultStartOfPreviousToken,
      startOfTranscriptToken: tokenizer.convertTokenToId("<|startoftranscript|>")
        ?? Self.defaultStartOfTranscriptToken,
      timeTokenBegin: tokenizer.convertTokenToId("<|0.00|>") ?? Self.defaultTimeTokenBegin,
      transcribeToken: tokenizer.convertTokenToId("<|transcribe|>") ?? Self.defaultTranscribeToken,
      translateToken: tokenizer.convertTokenToId("<|translate|>") ?? Self.defaultTranslateToken,
      whitespaceToken: tokenizer.convertTokenToId(" ") ?? Self.defaultWhitespaceToken
    )
    self.tokenizer = tokenizer
    self.tokenizerFolder = tokenizerFolder
    self.specialTokens = specialTokens
    self.allLanguageTokens = Set(
      Constants.languages
        .compactMap { tokenizer.convertTokenToId("<|\($0.value)|>") }
        .filter { $0 > specialTokens.specialTokenBegin }
    )
  }

  private func splitTokensOnUnicode(tokens: [Int]) -> (words: [String], wordTokens: [[Int]]) {
    let decodedFull = tokenizer.decode(tokens: tokens)
    let replacementString = "\u{fffd}"

    var words: [String] = []
    var wordTokens: [[Int]] = []
    var currentTokens: [Int] = []
    var unicodeOffset = 0

    for token in tokens {
      currentTokens.append(token)
      let decoded = tokenizer.decode(tokens: currentTokens)

      var hasUnicodeInFullString = false
      if let range = decoded.range(of: replacementString) {
        hasUnicodeInFullString = decodedFull[range] == replacementString
      }

      if !decoded.contains(replacementString) || hasUnicodeInFullString {
        words.append(decoded)
        wordTokens.append(currentTokens)
        currentTokens = []
        unicodeOffset += decoded.count
      }
    }

    return (words, wordTokens)
  }

  private func splitTokensOnSpaces(tokens: [Int]) -> (words: [String], wordTokens: [[Int]]) {
    let (subwords, subwordTokensList) = splitTokensOnUnicode(tokens: tokens)
    var words: [String] = []
    var wordTokens: [[Int]] = []

    for (subword, subwordTokens) in zip(subwords, subwordTokensList) {
      let special = subwordTokens.first! >= specialTokens.specialTokenBegin
      let withSpace = subword.hasPrefix(" ")
      var punctuation = false
      if let strippedSubword = UnicodeScalar(subword.trimmingCharacters(in: .whitespaces)) {
        punctuation = CharacterSet.punctuationCharacters.contains(strippedSubword)
      }
      if special || withSpace || punctuation || words.isEmpty {
        words.append(subword)
        wordTokens.append(subwordTokens)
      } else {
        words[words.count - 1] += subword
        wordTokens[words.count - 1].append(contentsOf: subwordTokens)
      }
    }

    return (words, wordTokens)
  }

  private func isPunctuation(_ text: String, tokenRange: Range<String.Index>, tag: NLTag?) -> Bool {
    let punctuationCharacters = CharacterSet.punctuationCharacters
    let token = String(text[tokenRange])
    if let tag = tag, tag == .punctuation {
      return true
    } else if token.unicodeScalars.allSatisfy({ punctuationCharacters.contains($0) }) {
      return true
    }
    return false
  }

  /// Decodes token ids into individual words and per-word subtokens
  /// - Parameter tokenIds: Array of tokens to decode and then split
  /// - Returns: Tuple containing and array of the split words and all tokens for each word
  public func splitToWordTokens(tokenIds: [Int]) -> (words: [String], wordTokens: [[Int]]) {
    let decodedWords = tokenizer.decode(
      tokens: tokenIds.filter { $0 < specialTokens.specialTokenBegin })

    // Detect language of input text
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(decodedWords)
    // NLLanguage raw values are BCP-47 tags ("zh-Hans", "zh-Hant"), while the
    // no-space-language list below uses Whisper's ISO 639-1 style codes ("zh").
    // Normalize via Locale so both Chinese variants match (matches openai/whisper,
    // which checks its decoding language code directly).
    let languageCode = recognizer.dominantLanguage.flatMap {
      Locale(identifier: $0.rawValue).language.languageCode?.identifier
    }

    if ["zh", "ja", "th", "lo", "my", "yue"].contains(languageCode) {
      return splitTokensOnUnicode(tokens: tokenIds)
    } else {
      return splitTokensOnSpaces(tokens: tokenIds)
    }
  }
}

extension LocalTokenizer {
  /// Default values for each token, using base vocab
  static var defaultWhitespaceToken: Int { 220 }
  static var defaultSpecialTokenBegin: Int { 50257 }
  static var defaultEndToken: Int { 50257 }
  static var defaultStartOfPreviousToken: Int { 50361 }
  static var defaultStartOfTranscriptToken: Int { 50258 }
  static var defaultEnglishToken: Int { 50259 }
  static var defaultTranscribeToken: Int { 50359 }
  static var defaultTranslateToken: Int { 50358 }
  static var defaultNoSpeechToken: Int { 50362 }
  static var defaultNoTimestampsToken: Int { 50363 }
  static var defaultTimeTokenBegin: Int { 50364 }
}
