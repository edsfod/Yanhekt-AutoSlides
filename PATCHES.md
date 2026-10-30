# Fork patches

This is a fork of [bit-admin/Yanhekt-AutoSlides](https://github.com/bit-admin/Yanhekt-AutoSlides).
It is rebuilt on every upstream stable release; this file is the complete list of
what differs from that release.

## Branches and tags

| Ref | What it is |
|---|---|
| `main` | Mirror of upstream `main`. Fast-forward only (`gh repo sync`); no fork commits. |
| `custom` | Upstream release tag + the patches below, one commit per patch. Rebased onto each new stable tag. |
| `v<X.Y.Z>-local.<n>` | Release build of `custom`. Pushing the tag runs `.github/workflows/local-release.yml`. |

Upstream's own workflows are **disabled in the fork's Actions settings**, not edited.
`release.yml` also matches `v*` tags and needs secrets this fork does not have.

## Rules for adding a patch

1. New code goes in its own files under `autoslides/src/main/local/` (main process) or
   `autoslides/src/renderer/local/` (renderer). Do not grow upstream files.
2. An upstream file gets only the smallest hook that calls the new code, marked with the
   comment `// Fork patch (PATCHES.md #n)`.
3. One commit per patch, message `local: <what> (PATCHES #n)`.
4. Add a row below: what it does, why, which upstream files it touches, and which upstream
   interfaces it relies on. After an upstream refactor, re-do the patch from this row.
5. If upstream would take it, open an issue/PR there first (#39 and #40 were accepted this
   way) and drop the patch once it ships.

## Updating to a new upstream release

```sh
git fetch upstream --tags
git switch custom
git rebase --onto <new-tag> <old-tag> custom      # replays only our commits
# fix conflicts using the table below; bump the version patch to <new-tag>-local.1
git push --force-with-lease origin custom
git tag v<X.Y.Z>-local.1 && git push origin v<X.Y.Z>-local.1
```

## Patches

| # | Patch | Why | Upstream files touched | Relies on |
|---|---|---|---|---|
| 1 | Update source is this fork's releases (`LOCAL_UPDATE_REPO` in `src/main/local/localBuild.ts`) | Upstream's updater verifies upstream's ed25519 signature; if "Check for Updates" still read upstream, it would offer, and could install, the official build over this one. Fork releases carry no `.sig`, so `supportsInPlaceUpdate` is false and the manual download-and-open flow is used. | `src/main/ipc/updateIpc.ts` (the `REPO` constant becomes an import) | `updateIpc.ts` reading GitHub releases through `REPO`; the in-place flow requiring `latest.yml` and a `.sig` asset |
| 2 | Version carries `-local.<n>` (`package.json`, `package-lock.json`) | Tells this build from the official one with the same base version, in the app's User-Agent and the installer file name. `compareVersions` reads `5.2.1-local.1` as newer than `5.2.1` and older than `5.2.2`. | `autoslides/package.json`, `autoslides/package-lock.json` | `compareVersions` splitting on `.` and `-` |
| 3 | Enable `room` (classroom camera) playback and download across Yanhekt 1.0, Yanhe 2.0, CLI, and Library (`src/main/local/roomStreamFallback.ts`) | Upstream gates `room` stream playback behind Developer Mode and refuses `room` downloads in Yanhe 2.0 and 1.0. This patch enables `room` playback without Developer Mode, extracts 1.0 `room` URLs when present, falls back to the Yanhe 2.0 twin's `room` stream when triggered from a 1.0 surface without a 1.0 `room_url`, and adds `room` to `LectureVideoType`, Yanhe 2.0 download service, CLI (`--stream room`/`all`), and Local Library. | `src/shared/apiTypes.ts`, `src/shared/lectureVideoNaming.ts`, `src/shared/yanhe2Download.ts`, `src/shared/cliControl.ts`, `src/preload/electronApi.ts`, `src/main/platform/apiClient.ts`, `src/main/video/videoProxyService.ts`, `src/main/video/yanhe2DownloadService.ts`, `src/main/ipc/downloadIpc.ts`, `src/main/cli/**`, `src/renderer/shared/services/downloadService.ts`, `src/renderer/features/**`, `src/renderer/components/**`, `src/renderer/shared/i18n/locales/*.json` | `yanhe2TwinResolver` + `yanhe2DownloadService.start`, `videoDownloader.downloadM3U8`, `buildLegacyLectureStem` / `LectureVideoType` |

## Known differences from the official build

- **The local course index (earlier terms) is off.** Its files are sealed with a passphrase that official Release builds get from the `INDEX_CLIENT_PASSPHRASE` secret at build time (`clientKey.ts`). Without it `CourseIndexBundle` answers `no-key` and `courseIndexUpdater` refuses to update (`this build has no index key`), so neither the bundled data nor the runtime download from upstream's `index` pre-release can be read. The code lookups that fall back to the online Index API (`share.ruc.edu.kg`, signed-in users, campus network) still work. This fork does not extract the passphrase from the official app; get it from, or agree an alternative with, the maintainer.
- **Unsigned installer.** Windows may show SmartScreen; there is no update signature.
- **Electron version** is whatever upstream pins. The earlier local bump to 44 is not carried.
