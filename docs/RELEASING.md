# Release checklist

CodePi's stable public macOS artifact must be signed with a **Developer ID
Application** certificate, notarized by Apple, and stapled before publication.
An ad-hoc signature or Apple Development certificate is suitable only for local
testing or an explicitly labeled development preview.

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the new
   semantic version.
2. From a clean checkout, run `npm ci` followed by `npm run check`.
3. Configure the signing and notarization credentials expected by
   `electron-builder`; keep all credentials in the release environment or
   encrypted repository secrets, never in source control.
4. Run `npm run dist:mac` on Apple silicon.
5. Verify the outputs:

   ```bash
   codesign --verify --deep --strict release/mac-arm64/CodePi.app
   spctl --assess --type execute --verbose release/mac-arm64/CodePi.app
   xcrun stapler validate release/mac-arm64/CodePi.app
   hdiutil verify release/CodePi-<version>-arm64.dmg
   shasum -a 256 release/CodePi-<version>-arm64.dmg
   ```

6. Install and launch the DMG on a Mac that does not have the development
   certificate or repository checkout.
7. Create a signed `v<version>` tag and a GitHub Release containing the DMG,
   blockmap, SHA-256 checksum, and release notes copied from the changelog.

Do not upload a stable release if Gatekeeper assessment or stapler validation
fails. A maintainer may publish an exceptional preview build only when both the
README and release notes clearly explain that Gatekeeper will block it, and the
GitHub release is marked as a pre-release.
