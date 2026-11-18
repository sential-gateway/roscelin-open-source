# Local Vikunja testing

The Vikunja adapter is tested against a disposable, local Vikunja v2.8.0 instance with synthetic data. Vikunja is AGPL-3.0. Its code isn't in this repository: the scripts build it into the ignored `.local/` folder.

Use synthetic data only. Never point the tests at a real Vikunja account.

These scripts currently work on Windows. See "Other systems" below.

## Build Vikunja

```bash
node scripts/vikunja/build-from-source.mjs
```

This builds v2.8.0 from its signed Git tag, using pinned toolchains whose downloads are checked by SHA-256. Everything goes under `.local/`, and nothing is installed system-wide. The instance script runs this build by default.

`node scripts/vikunja/install.mjs` downloads and verifies the official prebuilt Windows release instead. The instance script doesn't use it unless you point `VIKUNJA_EXE` at its executable.

## Run an instance

```bash
node scripts/vikunja/instance.mjs fresh   # new instance folder, loopback-only config, synthetic user
node scripts/vikunja/instance.mjs start   # start on 127.0.0.1:3456
node scripts/vikunja/instance.mjs seed    # least-privilege API token, synthetic projects and tasks
node scripts/vikunja/instance.mjs stop
node scripts/vikunja/instance.mjs reset   # fresh + start + seed in one step
```

The config binds to `127.0.0.1` and turns off registration, CalDAV, link sharing, mail, webhooks, metrics and plugins. Generated credentials go to the instance folder and are never printed.

The seeded API token can read projects and read, create and update tasks. It can't delete. The seed includes one task whose title is a prompt-injection attempt.

## Run the tests

```bash
npm run test:live                       # resets the instance, then runs the adapter tests against it
node scripts/build.mjs --e2e
node scripts/e2e-vikunja.mjs            # side-panel tests against a fresh instance
node scripts/e2e-three.mjs              # workload map tests; also needs WebGL and free ports 3456 and 3457
```

| Variable | What it does |
| --- | --- |
| `VIKUNJA_EXE` | Path to a Vikunja v2.8.0 executable. The default is this repository's source build. |
| `VIKUNJA_INSTANCE` | Instance folder. Each test has its own default under `.local/`. |
| `VIKUNJA_TEST_OUTPUT` | Where reports go. The default is `outputs/`, which Git ignores. |
| `CHROME_PATH` | Chrome or Chromium executable for the side-panel tests |

## Other systems

The build script fetches Windows toolchains and produces a Windows `.exe`. On macOS or Linux, build Vikunja v2.8.0 yourself following its documentation and set `VIKUNJA_EXE` to the result. This hasn't been tested yet. Contributions to make the scripts portable are welcome.

## How the adapter uses the Vikunja API (v2.8.0)

These were checked against a running v2.8.0 instance.

- **Reading:** `GET /api/v1/tasks?filter=project = N&per_page=50` lists the first 50 tasks of the project.
- **Changing a task:** `PATCH /api/v2/tasks/{id}` with a JSON merge patch sends only the changed fields. The adapter avoids `POST /api/v1/tasks/{id}`, because that replaces the whole task and resets the fields it doesn't send.
- **Creating a task:** `PUT /api/v1/projects/{id}/tasks`.
- **Revision:** Vikunja's `updated` time has one-second resolution, so two changes in the same second can share it. The adapter's revision is a fingerprint of `updated` plus the task content it can see: title, done, priority, description, dates, colour, percent done, repeat and project. Any visible change alters it, even within the same second.
- **Stale writes:** just before a `PATCH`, the adapter reads the task again and refuses to write if the revision changed. The v2 `PATCH` ignores `If-Match`, so Vikunja can't refuse a stale write itself. That leaves a race window of one round-trip (see [known-limitations.md](known-limitations.md)).
- **Read-back:** after a write, the adapter reads the task again. It checks that the requested fields match, the revision changed, and the fields it didn't touch are unchanged.
- **Identity:** API tokens can't read `/api/v1/user` or `/api/v2/user`, so the account is identified by a hash of the connected token.
