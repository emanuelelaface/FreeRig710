# Replace the old Raspberry Pi repository with FreeRig710

This release is intended as a complete source-tree replacement, not an in-place migration of the old Raspberry Pi application.

## Recommended workflow

First make a backup branch/tag of the old repository:

```bash
cd /path/to/old/FreeRig710
git status
git tag raspberry-final-before-1.0
git push origin raspberry-final-before-1.0
```

Extract the FreeRig710 release ZIP elsewhere, then replace every tracked/untracked project file while keeping the existing `.git` directory:

```bash
cd /path/to/old/FreeRig710
git rm -r .
rsync -a --exclude '.git' /path/to/extracted/FreeRig710/ ./
git add -A
git status
```

Review the diff carefully, then commit:

```bash
git commit -m "Release 1.0 - ESP32-P4 rewrite"
git push origin main
```

The old Raspberry Pi implementation is not carried inside this 1.0 tree. Git history/tagging remains the place to retrieve it.
