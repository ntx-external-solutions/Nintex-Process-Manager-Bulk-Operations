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
node dev/drive-move.mjs
node dev/drive-ownership.mjs   # SCIM key: scim-key
```

Each script prints the screens it passes through and the write calls the mock received.
`GET http://localhost:4999/tenant/_log` lists every request.
