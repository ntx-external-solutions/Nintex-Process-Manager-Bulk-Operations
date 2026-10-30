# Offline end-to-end checks

A mock Process Manager and a headless Chrome driver, for running the built app end to end
without a tenant. Development only: nothing here is imported by `src/`, so it is not part
of the production build.

```sh
# 1. The mock (resets its state on every start)
node dev/mock-pm.mjs 4999

# 2. The app, built as production
AUTH_SECRET=$(openssl rand -base64 48) npm run build
AUTH_SECRET=... SCIM_BASE_URL=http://localhost:4999 npx next start -p 3919

# 3. Chrome, headless, with a throwaway profile
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir="$(mktemp -d)" about:blank

# 4. A scenario. Restart the mock between scenarios.
node dev/drive-archive.mjs
node dev/drive-archive-ids.mjs    # Archive by tree and CSV together: plan, run, rows, cleanup offer (W7)
node dev/drive-move.mjs
node dev/drive-ownership.mjs   # SCIM key: scim-key
node dev/drive-expired.mjs     # the session dies between preview and run (R12)
node dev/drive-delete.mjs      # a Bulk Delete dry run: plans, writes nothing
node dev/drive-delete-run.mjs  # a real Bulk Delete: hold, remove, delete, put back, clean up
node dev/drive-delete-resume.mjs  # the session dies mid-run; sign in again and finish it from the saved plan
node dev/drive-delete-group.mjs    # delete by group: a checked group's archived processes too, then delete the emptied group
node dev/drive-delete-archived.mjs # the archived list and ids as ways in, as a dry run: writes nothing
node dev/drive-delete-refused.mjs  # the tenant refuses an active target's delete: Archive row, versions, active again
node dev/drive-docs-archive.mjs    # Archive documents by group, list and CSV: holders skipped, re-check, errors in a 200 (W8a)
node dev/drive-docs-delete.mjs     # Delete documents: archive first, typed DELETE, re-check, put back, cleanup (W8b)
node dev/drive-docs-restore.mjs    # Restore documents from the archived list and a Delete results file (W8c)
node dev/drive-docs-repair.mjs     # Repair document references: scan, repair published and draft holders, read back (W8d)
node dev/drive-docs-delete-resume.mjs   # Delete documents whose session dies at the delete; sign in again and finish it
node dev/drive-docs-archive-resume.mjs  # Archive documents whose session dies at the archive; sign in again and settle its rows
```

Each script prints the screens it passes through and the write calls the mock received.
`GET http://localhost:4999/tenant/_log` lists every request.
