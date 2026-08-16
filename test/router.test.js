/**
 * Unit tests for the ported router-core. Ported from upstream
 * dsh-router-standard preset/router.test.mjs, extended with the
 * SillyTavern-specific replaceSystemWithCore and prompt-array geometry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    appendUserAnchor,
    buildGuidance,
    classifyTask,
    corePersona,
    makeAnchorText,
    modelFamily,
    personaFor,
    replaceSystemWithCore,
} from '../router-core.js';

test('classifyTask routes spec keywords', () => {
    assert.equal(classifyTask('Architect a migration plan for the payments service'), 'spec');
    assert.equal(classifyTask('给我一个端到端的重构方案'), 'spec');
});

test('classifyTask routes react keywords', () => {
    assert.equal(classifyTask('Fix this bug in the login flow'), 'react');
    assert.equal(classifyTask('这个报错怎么修'), 'react');
});

test('classifyTask routes weak greetings', () => {
    assert.equal(classifyTask('hi'), 'weak');
    assert.equal(classifyTask('你好，在吗'), 'weak');
    assert.equal(classifyTask('总结一下刚才的结论'), 'weak');
});

test('classifyTask defaults to react and rejects empty input', () => {
    assert.equal(classifyTask('Write a poem about the sea'), 'react');
    assert.equal(classifyTask('h'), null);
    assert.equal(classifyTask(''), null);
    assert.equal(classifyTask(null), null);
});

test('modelFamily detects known ids', () => {
    assert.equal(modelFamily('deepseek_v4_pro'), 'DeepSeekPro');
    assert.equal(modelFamily('DeepSeek V4 Flash'), 'DeepSeekFlash');
    assert.equal(modelFamily('kimi-k2-thinking'), 'KimiK2');
    assert.equal(modelFamily('qwen3-coder-plus'), 'Qwen3Coder');
    assert.equal(modelFamily('kiro-1'), 'Kiro');
    assert.equal(modelFamily('MiniMax-M1'), 'MiniMaxM1');
    assert.equal(modelFamily('deepseek-chat'), 'DeepSeekOther');
    assert.equal(modelFamily('claude-sonnet-4'), 'DeepSeekOther');
});

test('personaFor picks band personas per family', () => {
    assert.equal(personaFor('DeepSeekPro', 'spec'), 'You are a senior software architect with attention to detail.');
    assert.equal(
        personaFor('DeepSeekFlash', 'react'),
        'You are a scientific software engineer doing high-performance number crunching.',
    );
    assert.equal(personaFor('DeepSeekPro', 'weak'), corePersona);
    assert.equal(personaFor('DeepSeekOther', 'spec'), corePersona);
    assert.equal(
        personaFor('KimiK2', 'weak'),
        'You are a helpful software engineer assistant. Keep responses terse and information-dense.',
    );
});

test('makeAnchorText only exists for measured families and offsets', () => {
    assert.equal(makeAnchorText('DeepSeekPro', 8), 'Read the directory before writing.');
    assert.equal(makeAnchorText('DeepSeekPro', 20), 'State the next step in one sentence; do not describe what you already see.');
    assert.equal(makeAnchorText('DeepSeekFlash', 8), 'State the next step in one sentence; do not describe what you already see.');
    assert.equal(makeAnchorText('DeepSeekFlash', 20), null);
    assert.equal(makeAnchorText('DeepSeekOther', 8), null);
});

test('appendUserAnchor is idempotent across regenerations', () => {
    const message = { role: 'user', content: 'Continue the story.' };
    appendUserAnchor(message, 8, 'DeepSeekPro');
    const once = message.content;
    appendUserAnchor(message, 8, 'DeepSeekPro');
    assert.equal(message.content, once);
    assert.ok(once.endsWith('[8]: Read the directory before writing.'));
    assert.ok(once.startsWith('Continue the story.'));
});

test('appendUserAnchor skips non-string content', () => {
    const message = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    appendUserAnchor(message, 8, 'DeepSeekPro');
    assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }]);
});

test('buildGuidance forces convergence for simple tasks near the window end', () => {
    const guide = buildGuidance([], 'react', 68, 100);
    assert.ok(guide.includes('Commit now to the exact final answer'));
    assert.equal(buildGuidance([], 'react', 10, 100), null);
    assert.equal(buildGuidance([], 'weak', 7, 10), 'You are about to fall out of the context window: Commit now to the exact final answer; no tool calls, no exploration, no reconsideration.');
});

test('buildGuidance demands decision closure for spec tasks at the window edge', () => {
    const guide = buildGuidance([], 'spec', 90, 100);
    assert.ok(guide.includes('write down the final decision in one sentence'));
    assert.equal(buildGuidance([], 'spec', 50, 100), null);
    assert.equal(buildGuidance([], 'spec', 0, 1), null);
});

test('replaceSystemWithCore collapses every system message into one core sentence', () => {
    const messages = [
        { role: 'system', content: 'You are Aria, a forest ranger.' },
        { role: 'system', content: 'World: Eldermere.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Welcome, traveler.' },
    ];
    replaceSystemWithCore(messages, corePersona);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], { role: 'system', content: corePersona });
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[2].role, 'assistant');
});

test('replaceSystemWithCore works with no system messages', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    replaceSystemWithCore(messages, corePersona);
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user']);
});
