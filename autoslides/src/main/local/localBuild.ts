// Fork-only identity. Everything that differs between this build and upstream's
// official release belongs in `src/main/local/` (see PATCHES.md at the repo root),
// so rebasing onto a new upstream release only has to re-point the few hooks.

/**
 * GitHub repository whose latest release "Check for Updates" offers.
 * Upstream's own releases are signed with the upstream project's key and would
 * replace this build with the official one, so the fork reads its own releases
 * (which carry no `.sig`, hence no in-place update: the download-and-open flow).
 */
export const LOCAL_UPDATE_REPO = 'edsfod/Yanhekt-AutoSlides';
