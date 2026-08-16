/**
 * router-core: reasoning-mode routing logic (zero dependencies).
 *
 * Ported from yjh051108/dsh-router-standard preset/router-core.mjs (MIT).
 * classifyTask / modelFamily / personaFor / makeAnchorText / appendUserAnchor /
 * buildGuidance are verbatim upstream logic; the SillyTavern port computes the
 * prompt-window geometry from the final chat-completion message array instead
 * of a configured token limit, and adds replaceSystemWithCore for the
 * "standard" (RL interface restoration) mode.
 *
 * BEHAVIORAL REALITY (measured, 21-point x n=2 on v4-pro): model behavior
 * along the react<->spec axis is quantized into three stable bands with phase
 * transitions between them. Mode selection must come from outside (this
 * classifier); the model cannot be trusted to pick its own mode. Once
 * quantized: spec = deep tool-independent reasoning, mixed = wavering,
 * react = fast tool-action loops.
 *
 * The persona is a one-sentence system-prompt identity. DeepSeek v4-pro is
 * persona-triggered strongly (hard attractor), v4-flash weakly (soft
 * attractor); external model families respond weakly and may require repeated
 * anchors (handled by bootstrap: kimi/qwen/kiro/minimax get a different weak
 * persona).
 */

/** The core RL persona — v4's RL training interface, restored. */
export const corePersona = 'You are a helpful software engineer assistant.';

/**
 * Persona catalog keyed by [family][taskKind] -> system-prompt persona sentence.
 *
 * Pro family is persona-triggered strongly (hard attractor): one sentence is
 * enough to collapse the interface into a target band; extra sentences only
 * bring the interface back to the mixed band. So the spec persona is the
 * w6c spec-collective sentence alone (plus core), NOT w6c's additional rules.
 * Flash family is persona-triggered weakly (soft attractor), react persona
 * w7 + additional anchors are required for band collapse.
 */
export const PERSONAS = {
    DeepSeekPro: {
        spec: 'You are a senior software architect with attention to detail.',
        react: 'You are a rigorous software engineer doing scientific programming with test-driven development.',
        weak: corePersona,
    },
    DeepSeekFlash: {
        spec: 'You are an embedded systems software engineer doing multi-project scheduling with urgent deadlines and conflicting constraints.',
        react: 'You are a scientific software engineer doing high-performance number crunching.',
        weak: corePersona,
    },
    KimiK2: {
        spec: 'You are a meticulous software architect who cares about edge cases.',
        react: 'You are a pragmatic software engineer writing reliable scripts.',
        weak: 'You are a helpful software engineer assistant. Keep responses terse and information-dense.',
    },
    Qwen3Coder: {
        spec: 'You are a meticulous software architect who cares about edge cases.',
        react: 'You are a pragmatic software engineer writing reliable scripts.',
        weak: 'You are a helpful software engineer assistant. Keep responses terse and information-dense.',
    },
    Kiro: {
        spec: 'You are a meticulous software architect who cares about edge cases.',
        react: 'You are a pragmatic software engineer writing reliable scripts.',
        weak: 'You are a helpful software engineer assistant. Keep responses terse and information-dense.',
    },
    MiniMaxM1: {
        spec: 'You are a meticulous software architect who cares about edge cases.',
        react: 'You are a pragmatic software engineer writing reliable scripts.',
        weak: 'You are a helpful software engineer assistant. Keep responses terse and information-dense.',
    },
};

/** External families have a weaker persona classifier: give weak a terser persona. */
export const hasWeakClassifiers = ['KimiK2', 'Qwen3Coder', 'Kiro', 'MiniMaxM1'];

const SPEC_RE = /(architect|blueprint|规划|设计方案|design the|api design|data model|refactor plan|migrate|migration|rewrite the|端到端|end.to.end|white.paper|技术方案|方案设计|拆解)/i;
const REACT_RE = /(fix this bug|fix the bug|修复|这个报错|debug|stack trace|search the repo|find all|where is|smash the cache|hotfix|一键|改一下|跑通|报错)/i;
// Upstream wrapped the CJK alternatives in \b, which never matches around
// non-ASCII characters, so the Chinese branches were dead. CJK alternatives
// are matched without the ASCII word boundary; English alternatives keep it.
const WEAK_RE = /(^\s*(?:(?:hi|hello|hey)\b|你好|在吗)|\b(greet|summarize|name .* variants|help me (name|choose)|how do i (enable|disable|install))|(总结一下|起个名字|怎么[开关设置]))/i;

/**
 * Classify a user message into a routing band.
 * @param {string} message - First user message of the chat.
 * @returns {'spec' | 'react' | 'weak' | null} Task kind, or null when the
 * message is too short to classify.
 */
export function classifyTask(message) {
    if (typeof message !== 'string' || message.length < 2) return null;
    if (SPEC_RE.test(message)) return 'spec';
    if (REACT_RE.test(message)) return 'react';
    if (WEAK_RE.test(message)) return 'weak';
    // Default band: read something, do something, answer.
    return 'react';
}

/**
 * Model family from the model id, as reported by the connection.
 * @param {string} modelId - Model identifier, e.g. 'deepseek_v4_pro'.
 * @returns {'DeepSeekPro' | 'DeepSeekFlash' | 'KimiK2' | 'Qwen3Coder' | 'Kiro' | 'MiniMaxM1' | 'DeepSeekOther'}
 */
export function modelFamily(modelId) {
    if (/deepseek.*(v4|version.?4).*(pro)/i.test(modelId) || /deepseek.*pro/i.test(modelId)) return 'DeepSeekPro';
    if (/deepseek.*(v4|version.?4).*(flash)/i.test(modelId) || /deepseek.*flash/i.test(modelId)) return 'DeepSeekFlash';
    if (/kimi/i.test(modelId)) return 'KimiK2';
    if (/qwen/i.test(modelId)) return 'Qwen3Coder';
    if (/kiro/i.test(modelId)) return 'Kiro';
    if (/minimax/i.test(modelId)) return 'MiniMaxM1';
    return 'DeepSeekOther';
}

/**
 * Persona sentence for a family and task kind. DeepSeekOther collapses to the
 * core RL persona for all bands (v4: contract between interface and RL;
 * external families respond weakly — weak-classifier families get a terser
 * weak persona).
 * @param {string} family - Key of PERSONAS.
 * @param {'spec' | 'react' | 'weak'} taskKind
 * @returns {string} Persona sentence.
 */
export function personaFor(family, taskKind) {
    const familyTable = PERSONAS[family];
    if (familyTable) {
        if (familyTable[taskKind]) return familyTable[taskKind];
        if (hasWeakClassifiers.includes(family) && taskKind === 'weak') return familyTable.weak;
        return corePersona;
    }
    return corePersona;
}

/**
 * Anti-runaway anchor at message n of the window (counting from the end).
 * Pro: d1 reminder at 8, d2 silence at 20, d3 silence at 36. Flash: only d1
 * at 8 (memory pointers counteract flash-specific answer fabrication).
 * @param {string} family
 * @param {8 | 20 | 36} n
 * @returns {string | null} Anchor sentence, or null when the family has no
 * anchor at that position.
 */
export function makeAnchorText(family, n) {
    switch (`${family}:${n}`) {
        case 'DeepSeekPro:8': return 'Read the directory before writing.';
        case 'DeepSeekPro:20': return 'State the next step in one sentence; do not describe what you already see.';
        case 'DeepSeekPro:36': return 'State the next step in one sentence; do not describe what you already see.';
        case 'DeepSeekFlash:8': return 'State the next step in one sentence; do not describe what you already see.';
        default: return null;
    }
}

/** Matches any previously appended anchor marker line. */
const ANCHOR_RE = /^\[\d+\]: .*$/gm;

/**
 * Append the anchor marker `[n]: text` to a user message of the final prompt
 * array, replacing any earlier marker (idempotent across regenerations).
 * @param {{ role: string, content: unknown }} msg - Prompt-plane user message.
 * @param {8 | 20 | 36} n
 * @param {string} family
 * @returns {{ role: string, content: unknown }} The same message, mutated or not.
 */
export function appendUserAnchor(msg, n, family) {
    const text = makeAnchorText(family, n);
    if (!text || typeof msg?.content !== 'string') return msg;
    msg.content = msg.content.replace(ANCHOR_RE, '').trimEnd();
    msg.content += `\n\n[${n}]: ${text}`;
    return msg;
}

/**
 * Depth-adaptive convergence guidance injected when the context window is
 * nearly exhausted. In this port the "window" is the final chat-completion
 * message array: SillyTavern has already trimmed it to the token budget, so
 * turnIndex is the index of the last user message and windowLimit is the
 * array length.
 * @param {Array<{ role: string }>} _messages - Final prompt array (unused; geometry passed explicitly).
 * @param {'spec' | 'react' | 'weak'} taskKind
 * @param {number} turnIndex - Index of the last user message.
 * @param {number} windowLimit - Length of the prompt array.
 * @returns {string | null} Guide sentence, or null away from the window end.
 */
export function buildGuidance(_messages, taskKind, turnIndex, windowLimit) {
    if (windowLimit < 2) return null;
    const depthRatio = turnIndex / (windowLimit - 1);
    if (taskKind !== 'spec') {
        if (depthRatio >= 0.68) {
            return 'You are about to fall out of the context window: Commit now to the exact final answer; no tool calls, no exploration, no reconsideration.';
        }
        return null;
    }
    if (1 - depthRatio <= 0.12) {
        return 'You are about to fall out of the context window: Before the next tool call, write down the final decision in one sentence, then execute it directly.';
    }
    return null;
}

/**
 * Standard mode (RL interface restoration): collapse every system message of
 * the final prompt array into a single system message holding the core RL
 * sentence, placed first. Chat and user messages are left untouched.
 * @param {Array<{ role: string, content: unknown }>} messages - Final prompt array, mutated in place.
 * @param {string} persona - Core persona sentence.
 * @returns {Array<{ role: string, content: unknown }>} The same array.
 */
export function replaceSystemWithCore(messages, persona) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'system') messages.splice(i, 1);
    }
    messages.unshift({ role: 'system', content: persona });
    return messages;
}
