/**
 * Module hooks that virtualize the five SillyTavern imports of index.js so
 * the real extension wiring can be exercised under `node --test`. The
 * specifier is redirected to a `virtual-stub:` URL served from memory; the
 * test file imports the same virtual URL to share module instances.
 */
const STUBS = {
    'virtual-stub:extensions.js': `
export const extension_settings = {};
export function getContext() { return globalThis.__stContext ?? {}; }
export async function renderExtensionTemplateAsync() { return ''; }
export function saveMetadataDebounced() {}
`,
    'virtual-stub:events.js': `
export const event_types = {
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
};
export const __listeners = {};
export const eventSource = {
    on(type, fn) { __listeners[type] = fn; },
};
`,
    'virtual-stub:i18n.js': `
export function t(strings, ...values) {
    return strings.map((s, i) => s + (values[i] ?? '')).join('');
}
`,
    'virtual-stub:script.js': `
export function saveSettingsDebounced() {}
globalThis.toastr = { info() {} };
const miniJq = () => ({ append() {}, on() {}, length: 0, prop: () => false, val: () => '', text() {} });
globalThis.jQuery = (fn) => { if (typeof fn === 'function') { fn(); return; } return miniJq(); };
globalThis.$ = () => miniJq();
`,
};

const STUB_NAMES = ['extensions.js', 'events.js', 'i18n.js', 'script.js'];

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('../../../') && STUB_NAMES.some((n) => specifier.endsWith('/' + n))) {
        return { url: 'virtual-stub:' + specifier.slice(specifier.lastIndexOf('/') + 1), shortCircuit: true };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith('virtual-stub:')) {
        return { format: 'module', shortCircuit: true, source: STUBS[url] };
    }
    return nextLoad(url, context);
}
