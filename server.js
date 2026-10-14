// Tiny zero-dependency server for the POC.
// - Serves ./public
// - Authenticates against GraFx with the OAuth client-credentials flow (the client secret never leaves this server)
// - Creates a new project from the configured template on every page load
// - Downloads the project document so the editor can load it at start
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const CONFIG_PATH = join(ROOT, 'config.json');

const DEFAULT_TOKEN_URL = 'https://integration-login.chiligrafx.com/oauth/token';
const DEFAULT_AUDIENCE = 'https://chiligrafx.com';
// Refresh the token this long before it actually expires.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

class ConfigError extends Error {}

// ---- Config ----

function readRawConfig() {
    if (!existsSync(CONFIG_PATH)) {
        throw new ConfigError('config.json not found. Copy config.example.json to config.json and fill in your values.');
    }
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        throw new ConfigError(`config.json is not valid JSON: ${e.message}`);
    }
}

const isSet = (value) => !!value && !String(value).includes('<');

// Read on every request, so config changes apply without restarting the server.
function loadConfig() {
    const raw = readRawConfig();
    const missing = ['environment', 'templateId', 'clientId', 'clientSecret'].filter((key) => !isSet(raw[key]));
    if (missing.length) throw new ConfigError(`config.json is missing values for: ${missing.join(', ')}`);

    const environment = String(raw.environment).trim();
    return {
        environment,
        templateId: String(raw.templateId).trim(),
        clientId: String(raw.clientId).trim(),
        clientSecret: String(raw.clientSecret).trim(),
        projectName: raw.projectName || 'Rich Text POC',
        studioUiVersion: raw.studioUiVersion || 'latest',
        tokenUrl: raw.tokenUrl || DEFAULT_TOKEN_URL,
        audience: raw.audience || DEFAULT_AUDIENCE,
        environmentApiBaseUrl:
            raw.environmentApiBaseUrl ||
            `https://${environment}.chili-publish.online/grafx/api/v1/environment/${environment}`,
    };
}

// ---- Authentication (client credentials) ----

let cachedToken = null; // { accessToken, expiresAt, cacheKey }
let pendingToken = null;

async function requestToken(config) {
    const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            audience: config.audience,
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
        throw new Error(
            `Authentication failed (${res.status}): ${body.error_description || body.error || 'no access token returned'}`,
        );
    }
    return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

async function getToken(config) {
    const cacheKey = `${config.tokenUrl}|${config.clientId}|${config.clientSecret}|${config.audience}`;
    const stillValid =
        cachedToken &&
        cachedToken.cacheKey === cacheKey &&
        cachedToken.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now();
    if (stillValid) return cachedToken;

    // Concurrent requests share one token call.
    pendingToken ??= requestToken(config)
        .then((token) => {
            cachedToken = { ...token, cacheKey };
            console.log(`  ✓ Token received, valid until ${new Date(token.expiresAt).toLocaleTimeString()}`);
            return cachedToken;
        })
        .finally(() => {
            pendingToken = null;
        });
    return pendingToken;
}

// ---- Environment API ----

async function environmentApi(config, path, init = {}) {
    const { accessToken } = await getToken(config);
    return fetch(`${config.environmentApiBaseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
    });
}

// Creates a fresh project from the configured template. Called on every page load.
async function createProjectFromTemplate(config) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const name = `${config.projectName} ${stamp}`;
    const res = await environmentApi(config, '/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, template: { id: config.templateId } }),
    });
    if (res.status === 404) {
        throw new ConfigError(
            `Template ${config.templateId} was not found in environment "${config.environment}", ` +
                'or it is not accessible for this integration.',
        );
    }
    if (!res.ok) {
        throw new Error(`Could not create a project from template ${config.templateId} (${res.status}): ${await res.text()}`);
    }
    const { id } = await res.json();
    console.log(`  ✓ Created project "${name}" (${id}) from template ${config.templateId}`);
    return { id, name };
}

// ---- HTTP ----

const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
};

const routes = {
    // Everything the page needs to start Studio. Never includes the client secret.
    '/api/session': async () => {
        const config = loadConfig();
        const project = await createProjectFromTemplate(config);
        const { accessToken, expiresAt } = await getToken(config);
        return {
            environment: config.environment,
            environmentApiBaseUrl: config.environmentApiBaseUrl,
            projectId: project.id,
            projectName: project.name,
            studioUiVersion: config.studioUiVersion,
            accessToken,
            expiresAt,
        };
    },

    // Used by Studio UI to refresh an expired token.
    '/api/token': async () => {
        const { accessToken, expiresAt } = await getToken(loadConfig());
        return { accessToken, expiresAt };
    },

    // The environment's rich text rule sets, used by the page to warn about rule sets that can't style the tags.
    '/api/rich-text-rules': async () => {
        const config = loadConfig();
        const res = await environmentApi(config, '/rich-text-rules?expand=All&limit=50');
        if (!res.ok) throw new Error(`Could not list rich text rule sets (${res.status}).`);
        const { data = [] } = await res.json();
        return { data };
    },

    // Downloads the project JSON, which the page loads into the editor at start.
    '/api/project/document': async (url) => {
        const config = loadConfig();
        const projectId = url.searchParams.get('projectId');
        if (!projectId) throw new ConfigError('projectId is required.');
        const res = await environmentApi(config, `/projects/${encodeURIComponent(projectId)}/document`);
        if (!res.ok) throw new Error(`Could not download project ${projectId} (${res.status}).`);
        return { raw: await res.text() };
    },
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    const route = routes[url.pathname];
    if (route) {
        try {
            const result = await route(url, req);
            if (result.raw !== undefined) {
                res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
                res.end(result.raw);
            } else {
                sendJson(res, 200, result);
            }
        } catch (e) {
            console.error(`  ✗ ${url.pathname}: ${e.message}`);
            sendJson(res, e instanceof ConfigError ? 400 : 502, { error: e.message });
        }
        return;
    }

    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const filePath = normalize(join(PUBLIC_DIR, requested));
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    try {
        const body = await readFile(filePath);
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(body);
    } catch {
        res.writeHead(404).end('Not found');
    }
});

function readPort() {
    if (process.env.PORT) return Number(process.env.PORT);
    try {
        return Number(readRawConfig().port) || 3001;
    } catch {
        return 3001;
    }
}

const port = readPort();
server.listen(port, '127.0.0.1', async () => {
    console.log(`\n  Studio Rich Text POC running at http://localhost:${port}\n`);
    // Fail fast on bad credentials instead of on the first page load.
    try {
        await getToken(loadConfig());
    } catch (e) {
        console.warn(`  ⚠  ${e.message}\n`);
    }
});
