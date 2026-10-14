import { mountRichTextEditors } from './richtext.js';

const CONTAINER_ID = 'studio-ui-container';

function showFatalError(message) {
    document.getElementById(CONTAINER_ID).hidden = true;
    document.getElementById('poc-loading').hidden = true;
    document.getElementById('poc-error-message').textContent = message;
    document.getElementById('poc-error').hidden = false;
}

// All /api calls go to the local server (server.js), which authenticates with the client credentials.
async function api(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) {
        const body = res.headers.get('Content-Type')?.includes('json') ? await res.json().catch(() => ({})) : {};
        throw new Error(body.error || `${path} failed (${res.status})`);
    }
    return res;
}

const fetchToken = () =>
    api('/api/token')
        .then((res) => res.json())
        .then((body) => body.accessToken);

async function loadStudioUI(version) {
    const url = `https://studio-cdn.chiligrafx.com/studio-ui/${encodeURIComponent(version)}/es-module/bundle.js`;
    try {
        const module = await import(url);
        return module.default;
    } catch (e) {
        throw new Error(`Could not load Studio UI from ${url} (${e.message}).`);
    }
}

// Keeps the custom rich text editors in sync with the document's variables.
async function watchVariables(editors) {
    const sdk = window.StudioUISDK;
    const ruleSets = await api('/api/rich-text-rules')
        .then((res) => res.json())
        .then((body) => body.data)
        .catch((e) => {
            console.warn('[POC] could not load rich text rule sets; skipping the setup check', e);
            return null;
        });

    // Warns in the editor when the rule set or the template's styles can't format the tags.
    let lastRuleSetIds = null;
    const checkSetup = async (variables) => {
        if (!ruleSets) return;
        const ruleSetIds = variables.map((v) => `${v.id}:${v.ruleSetId ?? ''}`).join('|');
        if (ruleSetIds === lastRuleSetIds) return;
        lastRuleSetIds = ruleSetIds;
        const [character, paragraph] = await Promise.all([
            sdk.characterStyle.getAll().then((r) => r.parsedData ?? []),
            sdk.paragraphStyle.getAll().then((r) => r.parsedData ?? []),
        ]);
        editors.checkSetup(ruleSets, { character, paragraph });
    };

    const update = (variables) => {
        editors.setVariables(variables);
        checkSetup(variables.filter((v) => v.type === 'richText')).catch((e) =>
            console.warn('[POC] setup check failed', e),
        );
    };
    const refresh = async () => {
        const { parsedData } = await sdk.variable.getAll();
        update(parsedData ?? []);
    };
    editors.onUnknownVariable(refresh);
    sdk.config?.events?.onVariableListChanged?.registerCallback(update);
    await refresh();
}

async function start() {
    // Every page load creates a new project from the configured template.
    const session = await api('/api/session').then((res) => res.json());
    const StudioUI = await loadStudioUI(session.studioUiVersion);
    window.StudioUI = StudioUI;

    const base = session.environmentApiBaseUrl;
    const { projectId } = session;
    const container = document.getElementById(CONTAINER_ID);
    const editors = mountRichTextEditors(container);

    StudioUI.studioUILoaderConfig({
        selector: CONTAINER_ID,
        projectId,
        projectName: session.projectName,
        graFxStudioEnvironmentApiBaseUrl: base,
        projectDownloadUrl: `${base}/projects/${projectId}/document`,
        projectUploadUrl: `${base}/projects/${projectId}`,
        authToken: session.accessToken,
        // The server fetches a new client-credentials token when the current one is about to expire.
        refreshTokenAction: fetchToken,
        onProjectDocumentRequested: () =>
            api(`/api/project/document?projectId=${encodeURIComponent(projectId)}`).then((res) => res.text()),
        uiOptions: { uiTheme: 'light' },
        onProjectLoaded: () => {
            document.getElementById('poc-loading').hidden = true;
            watchVariables(editors).catch((e) => console.error('[POC] could not read variables', e));
        },
        onLoadError: (error) => {
            console.error('[POC] project failed to load', error);
            showFatalError(`Project failed to load: ${error?.message ?? error}`);
        },
    });
}

start().catch((e) => {
    console.error('[POC]', e);
    showFatalError(e.message);
});
