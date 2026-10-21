# Release the Workshop extension

1. Create `release/<version>` from the latest `origin/main`. Ask for `<version>` if missing.
2. Add release notes for `<version>` to [CHANGELOG.md](../CHANGELOG.md), covering changes on
   `main` since the latest release tag. Follow the existing date and section format.
3. Update [package.json](../package.json) and [package-lock.json](../package-lock.json) with
   `workshop exec -- npm version <version> --no-git-tag-version`.
4. Run `workshop run -- build` and `workshop run -- test-ci`.
5. Sign and commit the release changes, push `release/<version>` to `origin`, and open a PR
   targeting `main`, titled `Release <version>`. Include a summary in the PR description.
6. After merge and passing CI, create a signed tag on the merged release commit with
   `git tag -s v<version> <commit> -m "Release <version>"`, then run
   `git push origin v<version>`. Confirm the [Publish workflow](../.github/workflows/publish.yml)
   succeeds: it checks the version, builds and tests the extension, and creates a GitHub
   release with generated notes and the `.vsix` attached. Marketplace publishing is not automated.
