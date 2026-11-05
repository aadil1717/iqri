# Iqri

**Recite in Arabic. Let the meaning follow you.**

Iqri is a calm, modern Quran learning demo that identifies your recitation and highlights the English meaning of the latest detected Arabic word within the current ayah. Your selected full-ayah translation remains underneath. It runs in a phone or desktop browser and includes an iPhone project for a future TestFlight beta.

**Live app:** https://iqri-recite-reflect-aadil.aaleem05.chatgpt.site/

## iPhone app

The Capacitor project in `ios/` targets iOS 17 or newer. It bundles the verified Quran recognition model and full-ayah translations for on-device recognition. English word glosses still require internet access. The microphone stops when the app enters the background; tap Start reciting to resume.

```sh
pnpm install --frozen-lockfile
pnpm mobile:sync
```

This builds and verifies the mobile assets and updates the native project. On a Mac with Xcode 26 or newer, use `pnpm ios:open`. On Windows, the manual GitHub Actions simulator workflow can build the project on a Mac runner. That simulator artifact cannot be installed on an iPhone. See [TestFlight setup](docs/TESTFLIGHT.md) for signing and distribution.

An active Apple Developer Program membership, an App Store Connect app, and signing credentials are required before a TestFlight upload. They have not been configured. iPhone hardware recognition speed has not yet been measured; desktop results do not establish iPhone performance.

## Try the demo on this Lenovo

1. Open the included **Start Iqri.cmd** launcher.
2. Visit **http://127.0.0.1:4317** in Chrome or Edge if the browser does not open automatically.
3. Choose **Start reciting**, allow microphone access, and recite a clear passage. The first use needs a moment to prepare the recognition model.
4. Keep **Find my place anywhere** selected, or select a surah to narrow recognition. English word mode starts enabled. Arabic and translation can each be shown or hidden independently. The recognition language is fixed to Quranic Arabic, regardless of the translation or display language.
5. Choose a language or change the English edition in **Reading preferences**. Stop listening whenever you finish.

Use **Find my place again** to clear recent recognition context without changing your selected surah. **Listening details** shows the most recent processing time.

With automatic following enabled, Iqri prepares the next ayah after recognizing the current ayah's complete final word and a brief quiet ending. The next card says **Ready for your next ayah** and stays unhighlighted until you recite. Pausing mid-ayah does not advance it, and repeating the completed ayah brings it back when fresh speech is recognized. At the end of a selected surah, Iqri shows **Surah complete**; automatic Quran-wide mode can continue into the next surah. It never wraps past the final ayah of the Quran. An unclear ending can leave the current card in place until more speech is recognized.

During live listening, **What Iqri hears · Arabic** shows the current speech-model transcript even before an ayah is identified. It is provisional recognition output and can contain mistakes; the Quran reading card always uses the separately verified canonical corpus. The transcript clears when listening stops or the search context resets and is not saved. The Arabic reading toggle independently controls canonical Quran text.

**Likely match · Still listening** is an early, provisional ayah preview. Shared openings retain their possible references until more speech distinguishes them. A likely match does not establish the recognizer's location, save a reading position, or highlight guessed words. Confirmed recognition can correct it. Older acoustic evidence cannot pull the reading card back from a newer preview; normal word highlighting resumes when the reference and word evidence are accepted.

**Explore a guided preview** demonstrates the reading interaction without listening. It is a scripted preview, not evidence of microphone recognition. You can also browse surahs, enter a reference such as `36:1`, save an ayah in this browser, and recognize an audio file.

The supplied launcher is configured for this laptop. Moving the source archive to another computer requires the developer setup below. A phone-friendly layout is included, but `127.0.0.1` always refers to the device on which you open it; this laptop address is not a public sharing link.

## Reading content

The Arabic corpus and every available translation contain **all 114 surahs and 6,236 Hafs-numbered ayahs**. Publisher wording and supplied footnotes are retained.

| Language | Included editions |
|---|---|
| English | Talal Itani / ClearQuran; Rowwad Translation Center; Noor International Center; Hilali & Khan; Marmaduke Pickthall |
| Spanish | Muhammad Isa García |
| Chinese | Muhammad Makeen, reviewed by Muhammad Sulaiman and other language experts |
| Tigrinya | Visible as unavailable; a complete attributed edition with verified reuse permission is still needed |

These are five established, reusable English choices, not a verified ranking of the five most popular translations. Talal Itani’s **ClearQuran** is distinct from Mustafa Khattab’s **The Clear Quran**. The legacy identifier `en-saheeh` is labeled **Noor International Center**, following the current source catalogue.

Tigrinya has not been replaced with Amharic, another language, or AI-generated translation. Its absence is an outstanding part of the requested four-language scope. Edition credits, notes, and sources are available inside the app.

## Voice recognition and privacy

The primary model is [Abdou / Abdeladim Fadheli's quran-asr-small](https://huggingface.co/Abdou/quran-asr-small), a 33-million-parameter, MIT-licensed Quran recognizer. In the local demo, short audio segments travel from the browser to a small service on this computer. Browser mode runs the same model on the device. Iqri does not save microphone recordings or send them to an analytics service. Reading preferences and saved ayahs remain in the browser. English word meanings use a separate online request to Quran.com that contains the ayah reference, not your voice recording.

This is an early recognition demo for **Hafs recitation**. It repeatedly analyzes short audio windows, so word highlighting may follow with a delay or advance by several words. Partial passages, background noise, long pauses, and short ayahs can delay or prevent a confident match. A shared passage may occur at several Quran locations: audio alone cannot identify which identical occurrence you intended. Iqri uses a selected surah or preceding accepted recitation when that resolves the ambiguity; otherwise it asks for more context.

The app retrieves published translations by verse reference. It does not invent or rewrite their wording. Tarteel was a product reference, and equivalent accuracy or behavior has not been established.

## English word meanings

Word mode displays the whole ayah as Quran.com’s English word glosses and highlights the source segment mapped to the latest detected Arabic word. The chosen natural full-ayah translation remains below it. A gloss can contain several English words; Arabic and English do not share a one-to-one word order. Highlighting a gloss does not claim exact word alignment inside Talal Itani, Pickthall, or another full translation.

The highlight comes from acoustic model evidence aligned to canonical Arabic characters and words, not a playback timer. It waits when the evidence or mapping is insufficient. Processing time, the amount of speech needed to identify a passage, and network loading of word meanings all affect the visible delay. Timing estimates are approximate, and updates can skip ahead during faster recitation. Historical FastConformer measurements below do not describe the replacement model's current app performance.

The provider is requested for an ayah being displayed. During confirmed live tracking in English word mode, Iqri also prepares the immediately next ayah within the listening scope to reduce loading delays. This happens once per newly recognized ayah, without bulk retrieval. Results stay in memory, with a maximum of 50 ayahs and a six-hour expiry; they are not included in the downloadable data, stored on disk, or promised offline. Internet or provider failure can make word meanings unavailable while the bundled full translations remain usable. Spanish and Chinese retain full-ayah translations; verified word-level glosses for those languages are not included.

The runtime loader validates the returned ayah, consecutive word positions, English language, and both Arabic spellings. Six representative live API responses, including the longest ayah and a spelling-boundary case, were checked. This is not an exhaustive audit of every provider gloss. See [Quran Foundation’s current terms](https://api-docs.quran.com/legal/developer-terms/) before changing caching or distribution.

## Developer setup

Use Node.js 24 and the pinned pnpm version in `package.json`. From this folder:

```powershell
pnpm install --frozen-lockfile
pnpm fetch:translations
pnpm fetch:models
pnpm build
pnpm start
```

Open http://127.0.0.1:4317. The initial setup downloads public datasets and model files. Reading data is approximately 11 MB; the primary model is 36,081,762 bytes (about 36 MB), plus a 180-byte character vocabulary. Runtime and dependency downloads are additional. The source archive excludes model weights; the setup command downloads the pinned model. Keep source notices with redistributed assets.

`pnpm fetch:translations` preserves source metadata and validates the exact 6,236 expected verse keys for each edition. It intentionally stops if a previously unavailable Tigrinya source appears, so that the new edition can be reviewed. `pnpm fetch:models` uses revision `004f898639f3127a74eac1b898a2cb3ef0b5268d` and requires the pinned SHA-256 hashes for the model, vocabulary, and MIT licence. Canonical reading text remains separately attributed.

```powershell
pnpm test
```

Tracker tests are separate from real-audio recognition checks. Reports named `recognition-native.json`, `recognition-wasm.json`, `word-progress-native.json`, and `word-progress-wasm.json` are retained historical FastConformer results, not validation of the new model. They cover individual verses, repeated-text ambiguity, silence, and a continuous studio recording of Al-Ikhlas. Small fixture checks do not establish accuracy for every reciter or a live microphone session. Dataset completeness is recorded in `dist/data/validation.json`.

See `RESEARCH.md` for the GitHub investigation and `THIRD_PARTY_NOTICES.md` for attribution and source terms. The demo also includes `/privacy.html` and `/terms.html`.


## Smoother live tracking

### Faster likely matches and recovery

The current decoder considers alternative acoustic letters directly against Quran word-start paths. A bounded CTC beam compares its Quran-constrained path with unconstrained acoustic evidence, retains competing locations, and needs agreement across overlapping clips before emitting a tentative preview. This is original project code using the existing pinned MIT model; it adds no model download or third-party dependency. Raw live transcription remains separate from canonical Quran text.

Microphone capture keeps the device's native audio clock. The worklet continuously resamples to the model's 16 kHz rate and sends exact 100 ms chunks without dropping the remaining samples. After a slow update, the transport coalesces up to two seconds of consecutive queued audio into one feed, allowing the rolling recognizer to catch up instead of replaying stale 480 ms batches. No captured samples are silently discarded; skipped intermediate inspection points do not produce invented highlights.

Normal word tracking keeps its two-second window. When accepted word evidence becomes stale, a separate four-second context check can recover the location or an acoustically supported word. It runs at most once per 800 ms and does not replace the fast window. Fresh automatic acquisition gives direct acoustic and exact-text matching four seconds of detected speech before expensive approximate whole-corpus searches begin. A usable acoustic candidate also suppresses redundant global fuzzy work. The fallback remains rate limited; deferred searches do not count as contradictory speech. Explicit surah selection and file recognition retain their existing lookup behavior.

A guessed location is insufficient to establish the first word cursor: its stable, complete acoustic words must independently identify the reference. Shared words such as Allah cannot validate a guessed ayah. Tentative evidence more than 1.2 seconds behind the processed audio is not displayed, and tied alternatives do not make the reading card flicker. Published joined-word spelling variants are supported in acquisition; word glosses first align against the verified complete Uthmani verse to avoid shifted provider word boundaries.

### Final November 4 browser verification

The final 42.67-second private Ayatul Kursi replay used the actual app, MediaStream, AudioWorklet, live queue, browser model worker, and rendered UI in automatic Quran-wide scope. Fixture playback and app capture shared one native-rate AudioContext: independent synthetic playback/capture contexts had drifted under CPU load, so those intermediate timings are not the release measurements. The final replay measured **3.79 seconds by the wall clock for the tentative 2:255 preview**, retaining 3:2 as a shared-opening alternative, and **8.89 seconds for confirmed 2:255**. The first Arabic text appeared at about 0.67 seconds of audio time. Nineteen distinct English gloss positions were highlighted; this does not establish complete or error-free word tracking.

The final synchronized browser replay of the longer recording confirmed 71:1, 71:2, 71:3, and 71:4 approximately **2.86, 3.76, 3.60, and 1.75 seconds** after their signal-estimated speech onsets, respectively. It emitted no other confirmed reference. These onset estimates are not manual phonetic annotations, and the very faint final 71:5 passage was not reliably recognized. Word highlighting remained incomplete, including no accepted highlight during 71:2 in this run. All 124 automated tests passed. Private recordings, raw transcripts, detailed replay reports, and test harnesses remain outside source and deployment.

These are bounded replay results on this laptop after model preparation, not a five-second guarantee for every ayah, microphone, reciter, or device. Tentative previews, confirmed references, and accepted word highlights are deliberately separate measurements.

The final native audio checks also pass: 11 independent acquisition cases, 19 recognition cases, 12 completion checks, and two ordinary-speech negative controls (44 case executions, not 44 distinct recordings). Eight of the 11 acquisition fixtures produce a useful candidate group or confirmed reference within five seconds of their provisional onset. Two require about six seconds; the repeated 55:13 refrain safely waits for context. The acquisition set has zero unsupported confirmed references. Ordinary Arabic and English controls produce zero tentative matches, confirmed references, or completions. Public-only fixture provenance and acquisition results are in `tests/acquisition-public-cases.json` and `tests/acquisition-native-public.json`; native audio-position timings are not browser wall-clock measurements.

### Earlier November 4 verification (before the changes above)

The later 42.67-second Ayatul Kursi recording was replayed locally through the actual browser MediaStream, worklet, live queue, model worker, and UI. The first Arabic transcript appeared at 0.56 seconds and the first confirmed 2:255 card at 11.8 seconds from the recording's start. There were 119 transcript updates and 14 distinct highlighted word positions; this does not establish complete word-by-word accuracy. The same native replay, using fixed 100 ms packets, confirmed the location at 8.6 seconds and its first word at 8.8 seconds, versus 11.6 seconds for both in the previous engine. The native and browser timings are different measurements; neither guarantees another microphone or device's delay. The private recording and detailed transcripts remain outside source and deployment.

The final browser completion check supplied only public 112:1 audio followed by silence. It displayed 112:2 as ready, with no highlighted word, before any 112:2 audio was supplied. Separate completion checks cover repeats, incomplete final words, mid-ayah pauses, noise, silence, and the final ayah of a selected surah. An ending can also be confirmed without a prior word highlight when three complete adjacent ending words uniquely identify the ayah and an independent acoustic context corroborates them after quiet; a lone common final word cannot trigger this path.

An actual browser replay of the user's 14.528-second recording exercised the MediaStream input, microphone worklet, continuous queue, model worker, and visible word elements at real speed. The final automatic-location run visibly highlighted 11 of 15 Al-Ikhlas word positions, versus four observed in the original screen recording, and reached the final word at about 11.2 seconds. Three missed positions preceded initial identification; one was at a later ayah boundary. Approximate later-word delay was 589 ms median against locally estimated acoustic frames. These are not manually verified word-boundary timings or a guarantee for another microphone, reciter, or device. The recording and detailed private report are excluded from source and deployment.

The browser used four CPU threads; a representative tracked update reported about 80 ms of processing, excluding speech acquisition and rendering. Nineteen independent public-audio checks pass: nine full-clip cases and ten continuous cases, including pauses, repeated ayahs, selected-surah filtering, ambiguity, silence, and recovery after a surah change. See `tests/streaming-native-public.json` and `scripts/streaming-public-check.mjs`. These checks establish their stated reference and safety conditions, not complete word accuracy: the slower public Al-Ikhlas sequence briefly revisits a previous word at a shared opening before reaching the correct final word.

The replacement recognition path uses short rolling audio windows and aims to accept fresh audio roughly every 200 ms. That cadence is a scheduling target, not a promise that every word appears within 200 ms. The model itself is an offline, full-attention Conformer; it is not a cache-aware streaming model. Short clips can produce incomplete words or incorrect completions, so reference and word updates need acoustic evidence and ambiguity checks. The voice model is fixed to Quranic Arabic; changing the translation language never switches recognition language.

Live Arabic transcription now has an independent update stream, so an uncertain verse match does not hide changing speech recognition. Acquisition remembers corroborated words and their acoustic positions for up to 16 seconds (64 words), joins only neighbors observed together, and compares sufficiently long complete spans with canonical Quran words and verified spelling variants. Shared passages retain all matching locations. A distinctive location can display its ayah before word alignment is ready, with no invented word highlight. Established word tracking keeps its short rolling window. Text history and lookup caches clear when the listening session ends or resets.

A selected surah now narrows the actual candidate search before matching, so starting at any ayah in it is supported. Exact Arabic passages use a fast canonical index across the Quran. In automatic mode, recent accepted recitation helps resolve repeated passages; inexact evidence falls back to a wider comparison. Ambiguous identical passages still require context. Arabic highlights are rendered from local Quran data independently of English word-meaning network requests. Existing word elements are reused between updates.

Iqri uses WhimprFlow's microphone level-display and capture-diagnostic ideas, adapted from its MIT source. Quran recognition continues to use the Quran-specific model; the English desktop dictation model and LLM cleanup are not part of the app. See the source and license details in `THIRD_PARTY_NOTICES.md`.


## Historical FastConformer v2 evidence

The following results describe the previous 88 MB FastConformer model and four/eight-second window design. They do not establish the replacement model's latency or accuracy. The retained reports are `tests/context-recognition-native.json`, `tests/context-recognition-wasm.json`, and `tests/word-progress-adaptive-native.json`. The matcher regression script also checks similar verses, shared fragments, clipped word boundaries, and stale surah context. Reproducing the old acoustic reports requires their original model and development fixtures; the ordinary unit suite does not download audio or models.

Paired native checks on three public studio clips retained the same correct references while reducing median processing from 568 to 335 ms, 651 to 347 ms, and 1323 to 926 ms. The first two clips are four seconds; the third is a twelve-second 2:255 acquisition clip. These small measurements exclude collecting speech, network loading, and rendering, and vary with laptop load. Shared or incomplete words may deliberately wait for more evidence.


The previous single-thread WebAssembly engine passed the same eleven recognition scenarios. Paired runtime medians for those three clips were 2351 to 2029 ms, 2471 to 2167 ms, and 5107 to 4640 ms. These historical measurements did not resolve the reported live-word latency and motivated replacing the acoustic model. Current performance needs measurement through the actual app, not an inference benchmark alone.
