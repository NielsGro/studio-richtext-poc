# Studio Rich Text – Proof of Concept

Embeds CHILI GraFx **Studio UI** in a web page and adds a custom editor for **Rich Text variables**:

- A long text field in the variables form, for every visible Rich Text variable.
- Three buttons below it that wrap the selected text in a tag:
  - **Bold**: `<b>…</b>`
  - **Large Text**: `<h1>…</h1>`
  - **Smaller Text**: `<h2>…</h2>`
- Two buttons that change the case of the selected text (or of all text, when nothing is selected):
  **UPPERCASE** and **lowercase**. They change the characters themselves and leave tags untouched, so they
  need no setup in GraFx and combine with every style.
- **Font size** controls for Large Text and Smaller Text (−, a number field in pt, +). They change the font
  size of the style that `<h1>` / `<h2>` map to in the rule set.
- Every page load creates a **new project from the configured template**.

No build step and no npm dependencies. You only need Node.js 18 or newer.

## Getting started

1. Copy the example config and fill in your values:

   ```bash
   cp config.example.json config.json
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Open <http://localhost:3001>.

## Configuration (`config.json`)

| Key                     | Required | Description                                                                                                        |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `environment`           | yes      | GraFx environment name, e.g. `cp-abc-123`.                                                                         |
| `templateId`            | yes      | Template to create a new project from on every page load.                                                          |
| `clientId`              | yes      | Client ID of the GraFx integration.                                                                                |
| `clientSecret`          | yes      | Client secret of the GraFx integration. Stays on the local server; never sent to the browser.                      |
| `projectName`           | no       | Prefix for the names of created projects; a timestamp is added. Default: `Rich Text POC`.                          |
| `studioUiVersion`       | no       | Studio UI version on the CDN, e.g. `latest` or a pinned version. Default: `latest`.                                |
| `tokenUrl`              | no       | OAuth token URL. Default: `https://integration-login.chiligrafx.com/oauth/token`.                                  |
| `audience`              | no       | OAuth audience. Default: `https://chiligrafx.com`.                                                                 |
| `environmentApiBaseUrl` | no       | Overrides the derived API URL `https://<environment>.chili-publish.online/grafx/api/v1/environment/<environment>`. |
| `port`                  | no       | Local port. Default: `3001`. The `PORT` env variable takes precedence.                                             |

The server reads `config.json` on every request, so changes apply on the next page load without a restart.

> `config.json` is git-ignored because it contains the client secret. Share `config.example.json` instead.

## Setting up the template

The buttons only insert tags. What those tags look like is decided by GraFx:

1. **Rich text rule set** (environment settings): create or edit a rule set with matchers for the tags
   `b`, `h1` and `h2`, each mapped to a character style (or paragraph style). The **tag** field of each
   matcher must be filled in. Rules with an empty tag match nothing.
2. **Template**: in Studio Designer, add a **Rich Text** variable, assign it the rule set, and put it
   in a text frame. The template's brand kit must contain the styles that the rule set names
   (for example `Bold`, `H1`, `H2`). A rule whose style does not exist leaves the text unstyled.
3. **Styles**: turn on the **fill color** of each style. With the fill color off, the styled text still
   takes up space but is invisible. Give `H1` and `H2` a font size, otherwise they keep the size of the
   surrounding text.

The editor checks this setup when the project loads. If the rule set has rules without a tag, has no rule
for `b`, `h1` or `h2`, names a style the template doesn't have, or uses a style with its fill color off, a yellow warning under the buttons lists
what to fix. Without a rule set on the variable, the field also shows the error from the engine.

## How it works

```
public/
  index.html   page with the container div Studio UI renders into
  app.js       creates the session, loads Studio UI from the CDN and starts it
  richtext.js  the custom rich text editor, injected into Studio UI's variables form
  styles.css   styling for the editor, the loading message and the error screen
server.js      zero-dependency server: static files, authentication and GraFx API calls
```

### Server endpoints

| Endpoint                    | Purpose                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/session`          | Creates a new project from `templateId` and returns its ID and an access token.               |
| `GET /api/token`            | Returns a valid access token; Studio UI calls it through `refreshTokenAction`.                |
| `GET /api/rich-text-rules`  | Lists the environment's rich text rule sets, for the setup check in the editor.               |
| `GET /api/project/document` | Downloads the project JSON, passed to the editor at start (`onProjectDocumentRequested`).     |

Tokens are cached on the server and renewed 5 minutes before they expire.

### The rich text editor

- Studio UI renders every visible variable in a wrapper `<div data-id="sui-variable-component-<variableId>">`.
  For Rich Text variables, it renders nothing inside it. `richtext.js` adds the custom editor to that
  wrapper. A `MutationObserver` adds it again whenever Studio UI re-renders the form.
- The list of variables comes from `StudioUISDK.variable.getAll()` and stays current through
  `StudioUISDK.config.events.onVariableListChanged`.
- Typing sends the text to the engine 400 ms after the last keystroke, and right away on a button click or
  when the field loses focus: `StudioUISDK.variable.setValue(variableId, markup)`. The engine parses the
  markup with the variable's rule set. A single line break becomes a line break, an empty line a new paragraph.
- A button wraps the selection in its tag. If the selection is already wrapped in that tag, the button
  removes the tag instead. With nothing selected, it inserts an empty tag pair with the caret in between.
  The edits go through the browser's text input, so **Ctrl+Z** undoes them.
- The case buttons don't use tags on purpose. Uppercase in GraFx would need a character style with a
  typographic case, and nested character styles don't combine: in `<h1><upper>…</upper></h1>` the inner style
  replaces H1, so the text would lose its H1 size.
- The font size controls look up the style through the variable's rule set (`h1` → e.g. character style `H1`)
  and call `characterStyle.update(id, { fontSize: { value } })` (or `paragraphStyle.update` for a paragraph
  rule). Typing applies the size 400 ms after the last keystroke; − and + change it by 1 pt. When the style has
  no size yet, the field shows "not set", and the first click sets 24 pt (Large Text) or 16 pt (Smaller Text).
  Sizes are kept between 1 and 1000 pt.

## Notes & limitations

- **Font sizes change the style, not the selection.** All text in the project that uses that style gets the
  new size, and the change is saved to the project, not to the template. To change the template's default sizes,
  edit the styles in Studio Designer.
- **A new project on every page load.** Each reload creates another project in the environment. Clean them
  up in GraFx now and then; they are named `Rich Text POC <timestamp>`.
- **The field starts empty.** The engine never returns the value of a Rich Text variable (it is always
  `null`), so the field can't show the template's default text. Text you type is kept in memory while the
  page is open.
- **The editor depends on Studio UI's DOM** (`data-id="sui-variable-component-…"`). If a future Studio UI
  version changes that markup, update `SLOT_PREFIX` in `public/richtext.js`. Pin `studioUiVersion` for stability.
- **Invalid markup is rejected.** Unclosed or mismatched tags make the engine throw a parse error, which is
  shown under the buttons. The previous valid text stays on the canvas.
- **The access token reaches the browser**, because the Studio editor needs it. The client secret does not.
  A production integration should issue short-lived tokens with limited scope.
- The server only listens on `127.0.0.1`. To share the POC, share the folder or repository without `config.json`.
