# Blame cache keyed by blob hash ignores history rewrites

The collector reuses cached blame when a file's blob hash is unchanged.
A revert that restores identical content, or a rebase that changes authorship without changing content, leaves stale ownership in the cache until the file changes again.
`idiolect scan --no-cache` works around it.
Fix idea: also key the cache on the HEAD commit of the file's history (`git log -1 --format=%H -- path`), which is cheap.
