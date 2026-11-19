# Accessibility

Roscelin is an early developer preview. This page says what has been checked, where you might get stuck, and how to tell us. It's a status page, not a certification or a conformance claim.

## What's tested

These are automated checks of this repository's code. They ran on Chrome 158.0.8127.37 on Windows 11. Side-panel checks run in Chrome's real side panel (headless).

| Check | Command | What it covers |
| --- | --- | --- |
| Keyboard | `npm run test:a11y` | The tabs work with arrow keys and Home and End, with one Tab stop. Filter options change with arrow keys and keep focus. A selection that's filtered out keeps a keyboard way in. Background updates don't move focus or the caret. |
| Labels | `npm run test:a11y` | Every form field in the workspace and in the layout preview has a unique, correctly linked label |
| Text size and narrow width | `npm run test:a11y` | At Roscelin's 200% text size, the panel and the workspace fit a 320 px wide panel without sideways scrolling |
| Screen-reader noise | `npm run test:a11y` | The source line isn't repeated as a live announcement. Read aloud starts only when you ask, and never for an empty workspace. |
| Colour contrast | `npm run check` | Text, field and focus colours meet WCAG 2.2 contrast ratios in the light, dark and high-contrast themes |
| Side panel use | `npm run test:panel` | Layouts, the review dialog, approvals, Stop, Profile and Activity, against the built-in test app |

### Not yet verified

- **NVDA:** not yet verified.
- **Narrator:** not yet verified.
- Keyboard-only use by a person, from start to finish.
- Chrome zoom at 200% and 400%.
- Windows high-contrast themes.
- Voice control and switch access.
- Read aloud with a real voice, and dictation with a real microphone.

We'll update this page when the first manual screen-reader pass is done.

## Known barriers and workarounds

- **A long panel.** The setup (the Vikunja connection, AI layouts, browser inspection) sits above your workspace. If you've allowed Vikunja but haven't connected it, its connection form appears even when you're working in another app. **Workaround:** the first Tab stop is "Skip to adapted workspace". You can also connect Vikunja, or remove its site access in Chrome's extension settings.
- **The workload map is optional and drawn on a canvas.** It's collapsed by default, and a table shows the same counts. You don't need the map for any task.
- **Read aloud and dictation are local only.** Read aloud needs an English voice installed on your computer. Dictation needs your browser's on-device speech support and language pack. Neither falls back to a cloud service, so on some computers they won't work.
- **AI layouts need a service you run yourself.** No AI service is included. Without one, Roscelin uses its built-in layouts, so nothing is lost.
- **Some actions aren't available.** Deleting a task isn't supported. Roscelin says so and sends you to the original app.

## Getting back to the original app

Roscelin never changes the original app's own screen. To go back at any time:

- **Close the side panel.** The app is exactly as it was.
- **Use "Open in original app"** in any layout.
- **Press Stop, or Alt+Shift+.** This pauses all reading and every action in every app until you choose Resume.
- **Cancel in the review dialog.** Every change shows there first, and nothing is sent until you confirm. Cancel, or Escape, leaves the app unchanged.

## Tell us about a barrier

Open an issue: [Report an accessibility barrier](https://github.com/sential-gateway/roscelin-open-source/issues/new?template=accessibility_barrier.yml). Please tell us:

- what you were trying to do;
- what got in the way;
- which browser (and version) and which assistive technology you used, if any.

You don't need to tell us about any diagnosis or disability. Leave out anything private. Please don't put security problems in public issues: see [SECURITY.md](SECURITY.md).
