# Iqri iOS preview and TestFlight

The iOS project and manual simulator workflow are prepared. Native Xcode compilation, real-iPhone microphone recognition, and TestFlight upload have **not yet been verified** at this handoff. The owner does not currently have Apple Developer Program membership; no signing credentials or TestFlight build have been created.

## Build a simulator preview from Windows

1. Open the private [Iqri repository](https://github.com/aadil1717/iqri) and select **Actions → iOS simulator preview → Run workflow**. The workflow must first be present on the default branch.
2. Select the branch to build and run it manually. It does not run on pushes or pull requests. GitHub macOS runner usage is subject to the account's Actions allowance and billing settings.
3. After a successful run, download **Iqri-Simulator-<run number>** from the run's artifacts. The artifact is retained for seven days.

The ZIP contains an unsigned **iOS Simulator `.app`**, not an iPhone-installable IPA. It requires a compatible Mac/Xcode simulator to run; it cannot be installed on an iPhone, opened as a Windows app, or uploaded to TestFlight. A passing build verifies compilation, not microphone quality or recognition speed on a phone. The browser demo remains the immediate Windows demo.

The workflow uses Node 24, pnpm 11.25.0, the committed lockfile, macOS 26, and Xcode 26.6. It runs `pnpm mobile:sync`, which builds the web app, verifies and bundles recognition assets, and syncs the native project. The project uses Capacitor 8.6.0 with Swift Package Manager, `@capacitor/app` 8.1.2, scheme `App`, and deployment target iOS 17.0. Current identity: `com.aadil1717.iqri`, version `0.1.0`, build `1`.

The three official GitHub actions are pinned to verified commits: [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1), [setup-node v7.1.0](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1), and [upload-artifact v7.0.2](https://github.com/actions/upload-artifact/commit/cf430e030ddbb5b0abf93d22962f4752f3646cd9). The job has read-only repository permissions, does not persist checkout credentials, and uses no Apple secrets. Xcode availability is documented in the [official runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md).

## Enable a real TestFlight beta after enrollment

These are future setup steps, not completed actions. Apple membership and signing are required for distributing a TestFlight beta. Windows can remain the development computer; compilation and signing can run on a trusted macOS build runner. [Apple membership](https://developer.apple.com/programs/enroll/), [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup)

1. The owner enrolls in the Apple Developer Program and completes Apple's identity, agreement, and payment steps.
2. Register the explicit App ID `com.aadil1717.iqri` under the owner's real Apple team, then create its iOS app record in App Store Connect. Confirm the bundle ID is available before its first release.
3. Create an Apple Distribution certificate with its private key and a matching App Store distribution provisioning profile. Export the signing identity as an encrypted `.p12`. Obtain an App Store Connect API key with the permissions needed to upload the build. No Apple ID password should be committed or pasted into the workflow.
4. Create a protected GitHub environment named `testflight` and configure the following inputs. Keep this separate from the unsigned simulator workflow.

| Input | Store as | Purpose |
| --- | --- | --- |
| `APPLE_TEAM_ID` | Environment variable | Actual enrolled team identifier |
| `BUILD_CERTIFICATE_BASE64` | Environment secret | Base64-encoded distribution `.p12` |
| `P12_PASSWORD` | Environment secret | Password protecting that certificate |
| `BUILD_PROVISION_PROFILE_BASE64` | Environment secret | Matching App Store `.mobileprovision` |
| `KEYCHAIN_PASSWORD` | Environment secret | Temporary CI keychain password |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | Environment secrets | App Store Connect API identifiers |
| `ASC_PRIVATE_KEY` | Environment secret | Downloaded API `.p8` private key |

5. Add a separate manual signed workflow after those inputs exist. Follow [GitHub's certificate and temporary-keychain procedure](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications). Build the same reviewed source with `pnpm mobile:sync`, increment `CURRENT_PROJECT_VERSION` for each uploaded build, and archive scheme `App` for `generic/platform=iOS` using the actual team and profile. Export an App Store distribution IPA with Xcode's export options; an unsigned simulator artifact cannot substitute for this archive.
6. Upload the signed IPA to the existing App Store Connect record using an API-key-authenticated tool, such as pinned Fastlane `pilot upload --api_key_path <temporary-key-json> --ipa <signed-ipa> --skip_submission`. Supply the actual temporary paths during workflow implementation; this command is a handoff example. `--skip_submission` uploads without automatically distributing to testers. Delete temporary key/profile/certificate files and the temporary keychain in an always-run cleanup step. Upload only intended build artifacts, never signing material. [Fastlane API-key upload](https://docs.fastlane.tools/actions/upload_to_testflight/)
7. Wait for Apple build processing, complete export-compliance questions and beta information with a real feedback email, then select the build for the intended TestFlight group. External testing may require Apple's beta review before an invitation link works. [Apple upload process](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/), [TestFlight setup](https://developer.apple.com/testflight/)

Keep signing files out of source control, logs, and build artifacts. Store secrets directly in GitHub's protected settings. Do not enable signed publishing for untrusted pull-request code.

Before sharing the beta, test microphone permission, interruptions/backgrounding, recognition, Arabic text, translations, and model loading on an actual iPhone. Wrapping the current web app does not itself improve speech-recognition accuracy or latency.
