/**
 * Custom editor for Rich Text variables.
 *
 * Studio UI renders an empty slot for Rich Text variables in the variables form
 * (`<div data-id="sui-variable-component-<id>">`). This module puts a long text field with
 * Bold / Large Text / Smaller Text buttons into that slot, and sends the markup to the engine
 * with `variable.setValue`. The engine parses the markup with the variable's rich text rule set,
 * which maps tags such as <b>, <h1> and <h2> to the template's styles.
 *
 * Below the buttons, size controls change the font size of the styles that <h1> and <h2> map to.
 */

const SLOT_PREFIX = 'sui-variable-component-';
const COMMIT_DELAY_MS = 400;

const FORMATS = [
    { tag: 'b', label: 'Bold', className: 'poc-rte__btn--bold' },
    { tag: 'h1', label: 'Large Text', className: 'poc-rte__btn--large', defaultSize: 24 },
    { tag: 'h2', label: 'Smaller Text', className: 'poc-rte__btn--small', defaultSize: 16 },
];

// Formats that get a font size control. `defaultSize` is the first size when the style has none yet.
const SIZED_FORMATS = FORMATS.filter((format) => format.defaultSize);
const MIN_FONT_SIZE = 1;
const MAX_FONT_SIZE = 1000;

// Case buttons change the selected characters themselves instead of adding a tag: a tag would need a
// character style, and nested character styles don't combine (<h1><upper>…</upper></h1> would lose H1).
const CASES = [
    {
        label: 'UPPERCASE',
        className: 'poc-rte__btn--case',
        title: 'Change the selected text (or all text, when nothing is selected) to uppercase',
        transform: (text) => text.toLocaleUpperCase(),
    },
    {
        label: 'lowercase',
        className: 'poc-rte__btn--case',
        title: 'Change the selected text (or all text, when nothing is selected) to lowercase',
        transform: (text) => text.toLocaleLowerCase(),
    },
];

// The engine does not return the value of a rich text variable (it is always null),
// so the markup the user typed is kept here. It survives Studio UI re-rendering the form.
const values = new Map(); // variableId -> markup
const committed = new Map(); // variableId -> markup last sent to the engine
const setupProblems = new Map(); // variableId -> list of reasons the tags won't be styled
// Rule sets and brand kit styles, from checkSetup. The styles are updated here when a size changes.
let setup = { ruleSets: [], styles: { character: [], paragraph: [] } };
let requestRender = () => {};

export function mountRichTextEditors(container) {
    let richTextVariables = new Map(); // variableId -> variable
    let knownIds = new Set(); // ids of all variables, so unknown slots can trigger a refresh
    let onUnknownVariable = null;
    let scanQueued = false;

    const scan = () => {
        scanQueued = false;
        let foundUnknown = false;
        for (const slot of container.querySelectorAll(`[data-id^="${SLOT_PREFIX}"]`)) {
            const id = slot.getAttribute('data-id').slice(SLOT_PREFIX.length);
            const variable = richTextVariables.get(id);
            const editor = slot.querySelector(':scope > .poc-rte');
            if (!knownIds.has(id)) foundUnknown = true;

            if (variable && !editor) slot.appendChild(createEditor(variable));
            else if (variable && editor) updateEditor(editor, variable);
            else if (!variable && editor) editor.remove();
        }
        if (foundUnknown) onUnknownVariable?.();
    };

    const queueScan = () => {
        if (scanQueued) return;
        scanQueued = true;
        // A timer rather than requestAnimationFrame, which doesn't run while the tab is in the background.
        setTimeout(scan, 0);
    };

    requestRender = queueScan;

    // Studio UI (React) re-renders the form often; re-add the editors whenever it does.
    new MutationObserver(queueScan).observe(container, { childList: true, subtree: true });

    return {
        setVariables(variables) {
            knownIds = new Set(variables.map((v) => v.id));
            richTextVariables = new Map(variables.filter((v) => v.type === 'richText').map((v) => [v.id, v]));
            queueScan();
        },
        /**
         * Checks for every rich text variable whether its rule set can style the tags of the buttons.
         * @param ruleSets the environment's rich text rule sets
         * @param styles { character, paragraph }: the style objects in the template's brand kit (from the SDK)
         */
        checkSetup(ruleSets, styles) {
            setup = { ruleSets, styles };
            setupProblems.clear();
            for (const variable of richTextVariables.values()) {
                setupProblems.set(variable.id, findSetupProblems(variable, ruleSets, styles));
            }
            queueScan();
        },
        onUnknownVariable(callback) {
            let pending = false;
            onUnknownVariable = () => {
                if (pending) return;
                pending = true;
                Promise.resolve(callback()).finally(() => {
                    pending = false;
                });
            };
        },
    };
}

// ---- Editor ----

function createEditor(variable) {
    const inputId = `poc-rte-${variable.id}`;

    const root = document.createElement('div');
    root.className = 'poc-rte';
    root.dataset.variableId = variable.id;

    const label = document.createElement('label');
    label.className = 'poc-rte__label';
    label.htmlFor = inputId;

    const textarea = document.createElement('textarea');
    textarea.id = inputId;
    textarea.className = 'poc-rte__input';
    textarea.rows = 6;
    textarea.spellcheck = true;
    textarea.value = values.get(variable.id) ?? '';

    const toolbar = document.createElement('div');
    toolbar.className = 'poc-rte__toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-controls', inputId);

    const addButton = ({ label, className, title }, apply) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `poc-rte__btn ${className}`;
        button.textContent = label;
        button.title = title;
        // Keep the focus (and so the selection) in the text field.
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
            apply();
            commit(root, variable.id, textarea.value);
        });
        toolbar.appendChild(button);
    };

    for (const format of FORMATS) {
        addButton({ ...format, title: `Wrap the selected text in <${format.tag}>…</${format.tag}>` }, () =>
            toggleTag(textarea, format.tag),
        );
    }
    // The case buttons go on their own row.
    const rowBreak = document.createElement('span');
    rowBreak.className = 'poc-rte__row-break';
    toolbar.appendChild(rowBreak);
    for (const textCase of CASES) {
        addButton(textCase, () => transformSelection(textarea, textCase.transform));
    }

    const help = document.createElement('p');
    help.className = 'poc-rte__help';

    const hint = document.createElement('p');
    hint.className = 'poc-rte__hint';
    hint.textContent = 'Select text, then pick a style. Enter adds a line break, an empty line starts a new paragraph.';

    const warning = document.createElement('div');
    warning.className = 'poc-rte__warning';
    warning.hidden = true;

    const sizes = createSizeControls(root, variable);

    const error = document.createElement('p');
    error.className = 'poc-rte__error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    let timer;
    textarea.addEventListener('input', () => {
        values.set(variable.id, textarea.value);
        clearTimeout(timer);
        timer = setTimeout(() => commit(root, variable.id, textarea.value), COMMIT_DELAY_MS);
    });
    textarea.addEventListener('blur', () => {
        clearTimeout(timer);
        commit(root, variable.id, textarea.value);
    });

    root.append(label, textarea, toolbar, help, hint, sizes, warning, error);
    updateEditor(root, variable);
    return root;
}

function updateEditor(root, variable) {
    const label = root.querySelector('.poc-rte__label');
    const text = variable.label || variable.name;
    if (label.dataset.text !== text || label.dataset.required !== String(variable.isRequired)) {
        label.dataset.text = text;
        label.dataset.required = String(variable.isRequired);
        label.textContent = text;
        if (variable.isRequired) {
            const star = document.createElement('span');
            star.className = 'poc-rte__required';
            star.textContent = ' *';
            label.appendChild(star);
        }
    }

    const textarea = root.querySelector('.poc-rte__input');
    textarea.placeholder = variable.placeholder || 'Type your text here…';
    textarea.readOnly = !!variable.isReadonly;
    for (const button of root.querySelectorAll('.poc-rte__btn')) button.disabled = !!variable.isReadonly;

    const help = root.querySelector('.poc-rte__help');
    help.textContent = variable.helpText || '';
    help.hidden = !variable.helpText;

    updateSizeControls(root, variable);

    const warning = root.querySelector('.poc-rte__warning');
    const problems = setupProblems.get(variable.id) ?? [];
    const key = problems.join('\n');
    if (warning.dataset.key !== key) {
        warning.dataset.key = key;
        warning.replaceChildren();
        if (problems.length) {
            const title = document.createElement('strong');
            title.textContent = 'The formatting will not show on the page:';
            const list = document.createElement('ul');
            for (const problem of problems) {
                const item = document.createElement('li');
                item.textContent = problem;
                list.appendChild(item);
            }
            warning.append(title, list);
        }
        warning.hidden = !problems.length;
    }
}

// ---- Font size controls ----

function createSizeControls(root, variable) {
    const section = document.createElement('div');
    section.className = 'poc-rte__sizes';
    section.hidden = true;

    const heading = document.createElement('p');
    heading.className = 'poc-rte__sizes-heading';
    heading.textContent = 'Font size';

    const note = document.createElement('p');
    note.className = 'poc-rte__hint';
    note.textContent = 'Changes the style, so all text with that style in the project gets the new size.';

    section.appendChild(heading);
    for (const format of SIZED_FORMATS) {
        const inputId = `poc-rte-size-${format.tag}-${variable.id}`;
        const row = document.createElement('div');
        row.className = 'poc-rte__size';
        row.dataset.tag = format.tag;

        const label = document.createElement('label');
        label.className = 'poc-rte__size-label';
        label.htmlFor = inputId;
        label.textContent = format.label;

        const input = document.createElement('input');
        input.id = inputId;
        input.className = 'poc-rte__size-input';
        input.type = 'number';
        input.min = String(MIN_FONT_SIZE);
        input.max = String(MAX_FONT_SIZE);
        input.step = '1';
        input.inputMode = 'decimal';

        const unit = document.createElement('span');
        unit.className = 'poc-rte__size-unit';
        unit.textContent = 'pt';

        const stepButton = (text, delta, title) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'poc-rte__size-btn';
            button.textContent = text;
            button.title = title;
            button.setAttribute('aria-label', title);
            button.addEventListener('click', () => {
                const current = currentStyle(variable, format.tag)?.style.fontSize;
                // Without a size yet, the first click sets the default size for this format.
                const next = current === undefined || current === null ? format.defaultSize : current + delta;
                applyFontSize(root, variable, format.tag, next);
            });
            return button;
        };

        let timer;
        const applyTyped = () => {
            clearTimeout(timer);
            const size = Number(input.value);
            if (input.value !== '' && Number.isFinite(size)) applyFontSize(root, variable, format.tag, size);
        };
        input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(applyTyped, COMMIT_DELAY_MS);
        });
        input.addEventListener('change', applyTyped);
        input.addEventListener('blur', () => updateSizeControls(root, variable)); // show the applied size

        row.append(
            label,
            stepButton('−', -1, `Make ${format.label} smaller`),
            input,
            stepButton('+', 1, `Make ${format.label} larger`),
            unit,
        );
        section.appendChild(row);
    }
    section.appendChild(note);
    return section;
}

// The style that `tag` maps to in the variable's rule set, if the template has it.
function currentStyle(variable, tag) {
    const ruleSet = setup.ruleSets.find((r) => r.id === variable.ruleSetId);
    const rule = ruleSet?.styleRules?.find((r) => r.matcher?.tag?.toLowerCase() === tag);
    if (!rule) return null;
    const [kind, styleName] =
        rule.styleKind === 'paragraph' ? ['paragraph', rule.paragraphStyleName] : ['character', rule.characterStyleName];
    const style = setup.styles[kind]?.find((s) => s.name === styleName);
    return style ? { kind, style } : null;
}

function updateSizeControls(root, variable) {
    const section = root.querySelector('.poc-rte__sizes');
    let anyVisible = false;
    for (const row of section.querySelectorAll('.poc-rte__size')) {
        const target = currentStyle(variable, row.dataset.tag);
        row.hidden = !target;
        if (!target) continue;
        anyVisible = true;

        const input = row.querySelector('.poc-rte__size-input');
        const size = target.style.fontSize;
        input.placeholder = 'not set';
        input.title = `Font size of ${target.kind} style "${target.style.name}"`;
        // Don't overwrite what the user is typing.
        if (document.activeElement !== input) input.value = size === undefined || size === null ? '' : String(size);
        for (const control of row.querySelectorAll('input, button')) control.disabled = !!variable.isReadonly;
    }
    section.hidden = !anyVisible;
}

async function applyFontSize(root, variable, tag, requested) {
    const target = currentStyle(variable, tag);
    if (!target) return;
    const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(requested * 10) / 10));
    if (size === target.style.fontSize) {
        updateSizeControls(root, variable);
        return;
    }

    const sdk = window.StudioUISDK;
    const controller = target.kind === 'paragraph' ? sdk.paragraphStyle : sdk.characterStyle;
    const error = root.querySelector('.poc-rte__error');
    try {
        await controller.update(target.style.id, { fontSize: { value: size } });
        target.style.fontSize = size;
        error.hidden = true;
        error.textContent = '';
    } catch (e) {
        console.error('[POC] could not change the font size', e);
        error.textContent = `Could not change the font size of "${target.style.name}": ${e?.message || e}`;
        error.hidden = false;
    }
    // Every editor using this style shows the new size.
    requestRender();
}

// ---- Setup check ----

function findSetupProblems(variable, ruleSets, styles) {
    if (!variable.ruleSetId) return ['The variable has no rich text rule set. Assign one in Studio Designer.'];
    const ruleSet = ruleSets.find((r) => r.id === variable.ruleSetId);
    if (!ruleSet) return [`Rule set ${variable.ruleSetId} was not found in the environment.`];

    const problems = [];
    const rules = ruleSet.styleRules ?? [];
    const emptyTags = rules.filter((rule) => !rule.matcher?.tag).length;
    if (emptyTags) {
        problems.push(`Rule set "${ruleSet.name}" has ${emptyTags} rule(s) without a tag; those match nothing.`);
    }

    for (const { tag } of FORMATS) {
        if (!rules.some((r) => r.matcher?.tag?.toLowerCase() === tag)) {
            problems.push(`Rule set "${ruleSet.name}" has no rule for <${tag}>.`);
        }
    }

    const styleProblems = new Set();
    for (const rule of rules) {
        const [kind, styleName] =
            rule.styleKind === 'paragraph'
                ? ['paragraph', rule.paragraphStyleName]
                : ['character', rule.characterStyleName];
        if (!styleName) continue;
        const style = styles[kind]?.find((s) => s.name === styleName);
        if (!style) {
            styleProblems.add(`The template has no ${kind} style "${styleName}", which rule set "${ruleSet.name}" uses.`);
        } else if (style.fillColorApplied === false) {
            // The engine then draws the text without a fill: it takes up space but is invisible.
            styleProblems.add(
                `The fill color of ${kind} style "${styleName}" is turned off, so its text is invisible. ` +
                    'Turn on the fill color in the style.',
            );
        }
    }
    problems.push(...styleProblems);
    return problems;
}

// ---- Applying the value ----

async function commit(root, variableId, markup) {
    values.set(variableId, markup);
    if (committed.get(variableId) === markup) return;
    committed.set(variableId, markup);

    const error = root.querySelector('.poc-rte__error');
    try {
        await window.StudioUISDK.variable.setValue(variableId, markup);
        error.hidden = true;
        error.textContent = '';
        root.classList.remove('poc-rte--invalid');
    } catch (e) {
        committed.delete(variableId); // try again on the next change
        console.error('[POC] could not set rich text value', e);
        error.textContent = describeError(e);
        error.hidden = false;
        root.classList.add('poc-rte--invalid');
    }
}

function describeError(e) {
    const message = e?.message || String(e);
    if (/rule/i.test(message)) {
        return (
            'This variable has no usable rich text rule set. In Studio Designer, assign a rule set to the ' +
            `variable that maps <b>, <h1> and <h2> to styles. (${message})`
        );
    }
    return `Could not apply the text: ${message}`;
}

// ---- Tag wrapping ----

/**
 * Wraps the selection in <tag>…</tag>. When the selection is already wrapped in that tag
 * (inside or just outside the selection), the tags are removed instead.
 * With nothing selected, an empty tag pair is inserted with the caret in between.
 */
function toggleTag(textarea, tag) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const { value } = textarea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);

    // <b>[selection]</b>
    if (value.slice(start - open.length, start) === open && value.slice(end, end + close.length) === close) {
        replaceRange(textarea, start - open.length, end + close.length, selected);
        textarea.setSelectionRange(start - open.length, end - open.length);
        return;
    }
    // [<b>selection</b>]
    if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
        const inner = selected.slice(open.length, selected.length - close.length);
        replaceRange(textarea, start, end, inner);
        textarea.setSelectionRange(start, start + inner.length);
        return;
    }

    replaceRange(textarea, start, end, `${open}${selected}${close}`);
    textarea.setSelectionRange(start + open.length, end + open.length);
}

/**
 * Applies `transform` to the text in the selection, leaving tags as they are (so <b> doesn't become <B>).
 * With nothing selected, the whole field is changed.
 */
function transformSelection(textarea, transform) {
    let start = textarea.selectionStart;
    let end = textarea.selectionEnd;
    if (start === end) {
        start = 0;
        end = textarea.value.length;
    }
    const selected = textarea.value.slice(start, end);
    const changed = selected
        .split(/(<[^>]*>)/)
        .map((part) => (part.startsWith('<') && part.endsWith('>') ? part : transform(part)))
        .join('');
    if (changed === selected) return;
    replaceRange(textarea, start, end, changed);
    textarea.setSelectionRange(start, start + changed.length);
}

// Replaces text the way typing does, so the browser's undo (Ctrl+Z) keeps working.
function replaceRange(textarea, start, end, text) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const inserted = text.length > 0 && document.execCommand?.('insertText', false, text);
    if (!inserted) {
        textarea.setRangeText(text, start, end, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
}
