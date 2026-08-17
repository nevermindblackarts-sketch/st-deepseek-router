/**
 * End-to-end smoke test of the real index.js wiring under stubbed SillyTavern
 * modules: drives the registered CHAT_COMPLETION_PROMPT_READY listener against
 * prompt arrays shaped like the ones SillyTavern emits ({ chat, dryRun }).
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('../stubs-loader.mjs', import.meta.url);

const _indexModule = await import('../index.js');
// index.js has no exports; reach its state through the shared stub modules.
const { extension_settings } = await import('virtual-stub:extensions.js');
// index.js registers its listeners inside an async jQuery-init callback; let it settle.
await new Promise((resolve) => setImmediate(resolve));
const { __listeners } = await import('virtual-stub:events.js');
const promptReady = __listeners['chat_completion_prompt_ready'];
assert.equal(typeof promptReady, 'function', 'listener registered on init');
// A user-visible turn must be in flight for routing to apply.
const beginTurn = (type = 'normal') => __listeners['generation_started'](type);
const endTurn = () => __listeners['generation_stopped']();
beginTurn();

function setContext(overrides = {}) {
    globalThis.__stContext = {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek-chat' },
        chat: [],
        chatMetadata: {},
        ...overrides,
    };
}

function rpPrompt(nUserTurns) {
    const messages = [
        { role: 'system', content: 'You are Aria, a forest ranger.' },
        { role: 'system', content: 'World: Eldermere.' },
    ];
    for (let i = 0; i < nUserTurns; i++) {
        messages.push({ role: 'user', content: `turn ${i}: *she waves*` });
        messages.push({ role: 'assistant', content: `reply ${i}` });
    }
    return messages;
}

const settings = () => extension_settings['st-deepseek-router'];

test('auto mode classifies the first stored user message and injects the core persona for deepseek-chat', () => {
    Object.assign(settings(), { mode: 'auto', anchorsEnabled: true, guidanceEnabled: true });
    setContext({ chat: [{ is_user: true, mes: '*she waves and walks closer*' }] });
    const messages = rpPrompt(3);
    promptReady({ chat: messages, dryRun: false });

    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].name, 'dsh_router');
    // DeepSeekOther collapses to the core RL persona for every band
    assert.equal(messages[0].content, 'You are a helpful software engineer assistant.');
    // card system messages untouched, exactly one router message, no anchors for this family
    assert.equal(messages[1].content, 'You are Aria, a forest ranger.');
    assert.equal(messages.filter((m) => m.name === 'dsh_router').length, 1);
    assert.equal(messages.some((m) => typeof m.content === 'string' && m.content.includes('[8]:')), false);
    // classification locked into chat metadata
    assert.equal(globalThis.__stContext.chatMetadata.dsh_router_state.taskKind, 'react');
});

test('listener is idempotent when SillyTavern replays the same array (dry run then send)', () => {
    Object.assign(settings(), { mode: 'auto' });
    setContext({ chat: [{ is_user: true, mes: 'hi' }] });
    const messages = rpPrompt(2);
    promptReady({ chat: messages, dryRun: true });
    const afterFirst = messages.length;
    promptReady({ chat: messages, dryRun: false });
    assert.equal(messages.length, afterFirst);
    assert.equal(messages.filter((m) => m.name === 'dsh_router').length, 1);
});

test('standard mode collapses every system message into the RL sentence', () => {
    Object.assign(settings(), { mode: 'standard' });
    setContext({ chat: [{ is_user: true, mes: 'hi' }] });
    const messages = rpPrompt(2);
    promptReady({ chat: messages, dryRun: false });
    const systemMessages = messages.filter((m) => m.role === 'system');
    assert.equal(systemMessages.length, 1);
    assert.equal(systemMessages[0].content, 'You are a helpful software engineer assistant.');
});

test('manual spec on v4-pro injects the architect persona, anchors, and spec guidance near the window edge', () => {
    Object.assign(settings(), { mode: 'spec', injectPosition: 'first', anchorsEnabled: true, guidanceEnabled: true });
    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek_v4_pro' }, chat: [] });
    const messages = rpPrompt(30);
    promptReady({ chat: messages, dryRun: false });

    assert.equal(messages[0].name, 'dsh_router');
    assert.equal(messages[0].content, 'You are a senior software architect with attention to detail.');

    const anchored = messages.filter((m) => typeof m.content === 'string' && /^\[\d+\]: /m.test(m.content));
    assert.equal(anchored.length, 3, 'pro anchors at 36/20/8 back from the window end');
    const [a8, a20, a36] = anchored.map((m) => m.content);
    assert.ok(a8.includes('[8]: Read the directory before writing.'));
    assert.ok(a20.includes('[20]:'));
    assert.ok(a36.includes('[36]:'));
    assert.ok(anchored.every((m) => m.role === 'user'), 'anchors land on user messages');

    const guide = messages.filter((m) => m.name === 'dsh_router_guide');
    // 62 messages + persona: last user index 61 of 63 total -> 1 - ratio <= 0.12
    assert.equal(guide.length, 1);
    assert.ok(guide[0].content.includes('write down the final decision'));
});

test('non-DeepSeek models and text-completion APIs are left untouched', () => {
    Object.assign(settings(), { mode: 'auto', applyToAllModels: false });
    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'claude-sonnet-4' }, chat: [{ is_user: true, mes: 'hello there' }] });
    const untouched = rpPrompt(2);
    promptReady({ chat: untouched, dryRun: false });
    assert.equal(untouched.some((m) => m.name === 'dsh_router'), false);

    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek-chat' }, chat: [{ is_user: true, mes: 'hello there' }] });
    const textApi = rpPrompt(2);
    globalThis.__stContext.mainApi = 'text';
    promptReady({ chat: textApi, dryRun: false });
    assert.equal(textApi.some((m) => m.name === 'dsh_router'), false);
});

test('after-system position injects the persona after the leading system block', () => {
    Object.assign(settings(), { mode: 'react', injectPosition: 'after-system', anchorsEnabled: false, guidanceEnabled: false });
    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek_v4_flash' }, chat: [] });
    const messages = rpPrompt(1);
    promptReady({ chat: messages, dryRun: false });
    assert.equal(messages[2].name, 'dsh_router');
    assert.equal(messages[2].content, 'You are a scientific software engineer doing high-performance number crunching.');
});

test('persona override wins over the family default', () => {
    Object.assign(settings(), { mode: 'react', injectPosition: 'first', anchorsEnabled: false, guidanceEnabled: false });
    settings().personaOverrides.react = 'You are a vivid novelist who commits to the scene.';
    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek-chat' }, chat: [] });
    const messages = rpPrompt(1);
    promptReady({ chat: messages, dryRun: false });
    assert.equal(messages[0].content, 'You are a vivid novelist who commits to the scene.');
    settings().personaOverrides.react = '';
});

test('model id resolves from the active chat-completion source (deepseek / openrouter)', () => {
    Object.assign(settings(), { mode: 'auto', enabled: true, applyToAllModels: false });
    setContext({
        chat: [{ is_user: true, mes: 'hello there' }],
        chatCompletionSettings: { chat_completion_source: 'deepseek', deepseek_model: 'deepseek-chat' },
    });
    const viaSource = rpPrompt(2);
    promptReady({ chat: viaSource, dryRun: false });
    assert.equal(viaSource.some((m) => m.name === 'dsh_router'), true);

    setContext({
        chat: [{ is_user: true, mes: 'hello there' }],
        chatCompletionSettings: { chat_completion_source: 'openrouter', openrouter_model: 'deepseek/deepseek-chat' },
    });
    const viaOpenrouter = rpPrompt(2);
    promptReady({ chat: viaOpenrouter, dryRun: false });
    assert.equal(viaOpenrouter.some((m) => m.name === 'dsh_router'), true);

    setContext({
        chat: [{ is_user: true, mes: 'hello there' }],
        chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'my-private-alias' },
    });
    const aliasModel = rpPrompt(2);
    promptReady({ chat: aliasModel, dryRun: false });
    assert.equal(aliasModel.some((m) => m.name === 'dsh_router'), false, 'alias without deepseek stays unrouted unless forced');
});

test('quiet generations and generateRaw calls are left untouched', () => {
    Object.assign(settings(), { mode: 'auto', enabled: true, applyToAllModels: false });
    setContext({ chat: [{ is_user: true, mes: 'hello there' }] });

    beginTurn('quiet');
    const quiet = rpPrompt(2);
    promptReady({ chat: quiet, dryRun: false });
    assert.equal(quiet.some((m) => m.name === 'dsh_router'), false, 'quiet background generation unrouted');

    endTurn();
    const raw = [{ role: 'system', content: 'Summarize the chat so far.' }];
    promptReady({ chat: raw, dryRun: false });
    assert.equal(raw.some((m) => m.name === 'dsh_router'), false, 'generateRaw array (no generation in flight) unrouted');
    assert.equal(raw.length, 1);

    beginTurn();
    const visible = rpPrompt(2);
    promptReady({ chat: visible, dryRun: false });
    assert.equal(visible.some((m) => m.name === 'dsh_router'), true, 'normal turns still routed');
});

test('master switch gates every injection; empty chats change nothing', () => {
    Object.assign(settings(), { mode: 'auto', enabled: false });
    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek-chat' }, chat: [{ is_user: true, mes: 'hello there' }] });
    const disabled = rpPrompt(2);
    promptReady({ chat: disabled, dryRun: false });
    assert.equal(disabled.some((m) => m.name === 'dsh_router'), false);

    settings().enabled = true;
    const enabled = rpPrompt(2);
    promptReady({ chat: enabled, dryRun: false });
    assert.equal(enabled.some((m) => m.name === 'dsh_router'), true);

    setContext({ chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'deepseek-chat' }, chat: [], chatMetadata: {} });
    const noUser = rpPrompt(2);
    promptReady({ chat: noUser, dryRun: false });
    assert.equal(noUser.some((m) => m.name === 'dsh_router'), false);
});
