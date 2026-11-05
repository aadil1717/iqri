# Iqri research notes

Research dates: **November 3–4, 2026 (America/Los_Angeles)**. These notes distinguish source claims, implementation choices, and unresolved work.

## The requested reverse-engineering skill

The exact match is **Reverse Engineer Anything (REA)** by `morluto`:

- [Official repository](https://github.com/morluto/rea)
- [Exact SKILL.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)

REA supplies an MIT-licensed CLI/MCP toolkit and agent skill for investigating shipped applications, binaries, APKs, JavaScript/Electron software, and runtime behavior. Finding the skill is separate from installing its tooling. It is not a Quran speech-recognition engine. Iqri can use published source code and model weights directly; its implementation does not require access to Tarteel’s private systems.

The latency follow-up read the published v60 skill and followed its source-available route: inspect complete repositories with ordinary development tools, pin the inputs, trace capture, feature extraction, model execution and alignment, then compare claims with measured behavior. No REA runtime or provider installation was needed for this route. Tarteel's private binary or production service was not inspected, so this work does not claim to reproduce its proprietary implementation.

## Recognition choice

Tarteel publishes the Apache-2.0 [whisper-base-ar-quran](https://huggingface.co/tarteel-ai/whisper-base-ar-quran) and [whisper-tiny-ar-quran](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran) models. Their existence does not establish that they match Tarteel’s current commercial recognition pipeline, streaming behavior, or accuracy. They are useful alternatives for future comparative evaluation, not a claim of proprietary feature parity.

Iqri now uses the MIT-licensed [Abdou/quran-asr-small](https://huggingface.co/Abdou/quran-asr-small), pinned to revision `004f898639f3127a74eac1b898a2cb3ef0b5268d`. Its 33-million-parameter Conformer CTC model has a 36,081,762-byte quantized ONNX file and 180-byte vocabulary. Immutable download URLs, file sizes, and SHA-256 hashes are recorded in `src/recognition/config.js`; the setup script verifies them. The official model exports `x` and `x_lens` inputs without a persistent encoder-cache interface. It is an offline model evaluated on short rolling audio, not a genuinely cached streaming encoder. A 200 ms update cadence is a scheduling target, not a guarantee of recognition or word-highlight latency.

The pipeline retains [Tilawi/quran-asr](https://github.com/Tilawi/quran-asr) matching helpers and adapts only the MIT filterbank signal-processing code from [yazinsai/tilawa](https://github.com/yazinsai/tilawa), commit `2f2617460dc4a6b967e0cc49fa04804bbf22ec69`. It does not deploy that project's NPL-licensed model or phoneme corpus. The selected model permits commercial use under MIT, with its notice preserved; reading content and live API usage still have their own conditions.

The earlier implementation used the [Tilawi FastConformer Quran model](https://huggingface.co/muhdur/tilawi-fastconformer-quran). Its saved benchmark files remain historical evidence and do not measure the replacement model. Upstream model accuracy claims and isolated prototype timings do not establish Iqri's end-to-end latency or live-user accuracy. Live microphone quality across different voices, accents, rooms, and recitation speeds still needs broader evaluation.

Recognition produces a reference and partial recitation information, then the app looks up the published translation. Whole-ayah editions remain intact. The added English word-learning mode uses separately supplied, explicitly aligned word glosses; it does not manufacture alignment inside those editions. Identical Quran passages require context; “recognize anywhere” cannot make an acoustically identical occurrence unique.

## Word-by-word learning

Iqri now defaults to an English word mode: the complete ayah is shown as source word glosses, the segment corresponding to the latest detected Arabic word is highlighted, and the chosen natural full-ayah translation remains below. `src/recognition/word-progress.js` retains acoustic CTC emission positions, aligns normalized Arabic characters to the model’s canonical text, and accepts supported final-word or partial-word evidence. Ambiguous or insufficient evidence produces no word-progress update. The UI separately maps that canonical word to provider Arabic boundaries rather than assuming matching indexes.

The historical FastConformer files `tests/word-progress-native.json` and `tests/word-progress-wasm.json` record progression on a continuous studio recording of Al-Ikhlas. That earlier model took approximately 0.2–0.8 seconds native and 0.8–2.9 seconds WebAssembly per tested window. These are not measurements of the current 33M model. Initial audio collection, model loading, inference, evidence confirmation, and fetching word meanings all affect what the user sees; model execution time alone is not word-highlight latency.

The public [Quran.com verse-by-key endpoint](https://api.quran.com/api/v4/verses/by_key/112:1?language=en&words=true&word_fields=text_uthmani,text_imlaei) returned HTTP 200 with Arabic Uthmani and Imlaei spellings, consecutive word positions, and English meanings. The loader was checked against `1:1`, `2:282`, `12:39`, `55:13`, `112:1`, and `114:6`. Verse-end markers are excluded. A provider “word” can contain spaces in Imlaei spelling, so recognition must match normalized Arabic sequences rather than assume whitespace positions are identical.

[Quran Foundation’s developer terms](https://api-docs.quran.com/legal/developer-terms/) permit app display under conditions, but do not grant general redistribution of a prepackaged word dataset. Accordingly, Iqri fetches the displayed ayah at runtime and prepares the immediately next ayah during confirmed live English word tracking, keeps only a bounded, expiring memory cache, and does not ship `words-en.json`. The source text is not relabeled as one of the five English editions. No verified Spanish or Chinese word-gloss source was integrated.

The [Quranic Arabic Corpus](https://corpus.quran.com/) and [QUL](https://qul.tarteel.ai/) are valuable research sources, but an open-source frontend licence does not automatically license every translation file. QUL explicitly makes reuse dependent on each [resource’s terms](https://qul.tarteel.ai/faq). The [open word-translation permission question](https://github.com/TarteelAI/quranic-universal-library/issues/638) did not provide a blanket redistribution grant. The live-display approach keeps this unresolved corpus-bundling question separate from the working demo.

## Repositories worth keeping

| Repository | Relevance to Iqri | Current use |
|---|---|---|
| [Abdou/quran-asr-small](https://huggingface.co/Abdou/quran-asr-small) | Small Quran-specific CTC model, published source and ONNX export | Primary MIT model |
| [Tilawi/quran-asr](https://github.com/Tilawi/quran-asr) | Quran-specific reference matching | Matching helper dependency |
| [yazinsai/tilawa](https://github.com/yazinsai/tilawa) | Cached streaming research and pure JavaScript filterbank extraction | MIT filterbank adaptation only; its NPL model and corpus are excluded |
| [risan/quran-json](https://github.com/risan/quran-json) | Structured Arabic corpus, translation editions, provenance | Reading-data source, alongside direct QuranEnc downloads |
| [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | Runs the recognition model locally | Runtime dependency |
| [github/spec-kit](https://github.com/github/spec-kit) | Structured product specifications and development workflow | Optional development tooling; not installed as an Iqri dependency |
| [debpalash/VoiceStudio](https://github.com/debpalash/VoiceStudio) | Broader local audio and transcription tooling | Optional research reference; not a dependency or Quran translation source |

Spec Kit and VoiceStudio were spotted in retrieved cached GitHub Trending results during the research pass. This is a discovery snapshot, **not a verified current ranking or a measurement of star growth**. Repository popularity alone does not demonstrate Quran recognition quality. Dependencies were selected for their fit and source terms.

## Translation sourcing and the Tigrinya gap

[QuranEnc’s API](https://quranenc.com/en/home/api) and [republishing terms](https://quranenc.com/en/home/about) provide attributed editions with versioned downloads. Iqri downloaded the latest available Rowwad, Noor International, Hilali & Khan, Spanish García, and Chinese Suleiman CSVs directly, retaining publisher information and footnotes. Talal Itani and Pickthall came through the attributed quran-json catalogue. Talal Itani provides explicit [reuse and conversion permission](https://clearquran.com/download/).

The five English choices are established editions available under usable terms; no reliable evidence established a definitive “five most popular” ranking. Their names are preserved accurately: the current QuranEnc `english_saheeh` entry names Noor International, and Talal Itani’s ClearQuran is not Mustafa Khattab’s The Clear Quran.

The [Tigrinya catalogue query](https://quranenc.com/api/v1/translations/list/ti?localization=en) returned an empty array, and the reviewed quran-json catalogue had no Tigrinya edition. [Quran Ethiopia](https://quranethiopia.com/tigrinya-quran/) advertises Tigrinya but the inspected material did not establish a named translation edition and reuse permission. A [Juz Amma PDF attributed to Dr. Bayan Saleh](https://www.maktabah.org/fa/item/1992-quran-translation-tigrinya) is partial and not a ready, licensed, verse-aligned full corpus. [IslamHouse’s Tigrinya books](https://islamhouse.com/en/books/ti/1/) also did not supply a full suitable dataset.

The app therefore shows Tigrinya as unavailable. Completing that language requires an identified publisher/translator, permission to reuse the text, digitization or a structured source, and native-language review of verse alignment. Amharic, Tigre, Tajik, and generated translations are not substitutes.

## Demo and next evidence to collect

A local Windows browser demo gives this Lenovo a direct path to try the experience without TestFlight. The server uses loopback at `127.0.0.1:4317`; it is not a public deployment. A responsive layout supports future phone trials, but mobile distribution and browser-wide performance remain separate validation work.

The completed data checks cover every expected verse key and nonempty text across all seven available editions. Recognition fixture checks cover a few specific utterances, silence, and repeated-text ambiguity. Before claiming production readiness, collect live-user accuracy and latency measurements, test uninterrupted recitation and recovery after mistakes, verify additional devices, and finish Tigrinya sourcing.


## PublikHQ / WhimprFlow follow-up

The requested directory is [PublikHQ](https://www.publikhq.com/whimprflow), whose WhimprFlow listing links to [Blueturboguy07/WhimprFlow](https://github.com/Blueturboguy07/WhimprFlow). The reviewed repository commit is `bb222a23563d076f50d8d068d3d0e1b8267c1a7a`, under MIT.

The actual ASR implementation in `crates/whimpr-asr/src/lib.rs` declares streaming unsupported, accumulates audio until the utterance ends, and specifies English. The default model configuration uses `ggml-base.en.bin`. Replacing the Quran recognizer with that implementation would not provide Arabic streaming or Quran reference mapping. Iqri instead ports its measured microphone level history and quiet-capture diagnostics, with the complete MIT notice. No paid Publik service or desktop install is required.

The user's requested contextual recognition combines an exact Arabic passage index with recognition scoped to a selected surah. The acoustic model supplies the evidence; recent accepted recitation helps disambiguate repeated passages. Inexact evidence in automatic mode receives a global comparison so that a similar verse in the previous surah cannot override a new location. Search must still allow an arbitrary ayah, backward jumps, and repeats. Weak evidence broadens the search in automatic mode instead of rewriting recitation with a general-purpose LLM. Published Arabic and translations remain unchanged.


The matching checks include confusable pairs 2:136/3:84, 7:65/11:50, and backward jumps among similar ayahs in surah 26. Shared fragments and partial-word boundaries cannot establish a unique new reference. Historical FastConformer native and single-thread WebAssembly checks passed eleven actual-audio scenarios; their paired timings are saved in `tests/context-recognition-native.json` and `tests/context-recognition-wasm.json`. These do not certify the replacement model. The frontend separately rejects obsolete acoustic evidence and prepares only the next ayah's English meanings during live tracking.

## Commercial eligibility and streaming tradeoff

Tilawa's cached Zipformer model was evaluated privately as a latency comparison. Its model and phoneme corpus use the [NPL-1.2 licence](https://github.com/yazinsai/tilawa/blob/2f2617460dc4a6b967e0cc49fa04804bbf22ec69/licenses/NPL-1.2.txt), which restricts paid, advertising-supported, and other commercial uses of the powered feature. A free prototype would not establish permission for future monetization. Because the user requested commercial eligibility, those assets are excluded from Iqri and its distribution; only separately MIT-licensed signal-processing source is adapted.

The MIT 33M model preserves more product options at the cost of using short rolling inference rather than a cache-aware encoder. Conservative acoustic evidence checks remain necessary: an offline model can predict a familiar verse ending before the speaker finishes, and repeated Arabic phrases cannot identify a unique occurrence without context. Neither a smaller file nor a fast isolated inference proves correct real-time highlighting. The model's MIT grant does not supersede Quran text, translation publisher, or Quran Foundation API conditions; those remain recorded in `THIRD_PARTY_NOTICES.md` and the data provenance files.

The final implementation keeps one contiguous audio session across ayahs, aligns stable acoustic evidence to the current word and nearby continuation, and expands acquisition context when needed. Known source spelling variants are taken from the same pinned model's MIT `spelling.json`, with its exact hash and attribution in `src/recognition/quran-orthography.js`. They never rewrite displayed Quran text or globally substitute ambiguous Arabic words. A browser isolation response wrapper adapted from [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) enables parallel WebAssembly where the host does not supply the required headers; a local browser test verified isolation and shared-memory support.

Validation now includes real-speed browser replay through the actual microphone-to-display pipeline, rather than model timing alone. The final automatic-location replay showed 11 of 15 word positions, approximately 589 ms median later-word delay against estimated acoustic frames, and the final word. All 19 separately sourced public-audio regression cases passed their explicit reference/ambiguity/final-word checks. Initial identification, similar openings, and some individual words remain imperfect. The private recording and its detailed results stay outside the repository and published assets; only aggregate findings are documented here.
