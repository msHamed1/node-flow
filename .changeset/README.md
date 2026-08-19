# Changesets

Every pull request that changes a published package should include a changeset:

```bash
yarn changeset
```

Select every affected package, choose the SemVer bump, and describe the user-visible change. Commit
the generated Markdown file with the implementation. Documentation-only, test-only, and internal
workflow changes do not require a changeset.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the complete policy.
