/**
 * st-deepseek-router — SillyTavern port of yjh051108/dsh-router-standard:
 * task-aware reasoning-mode routing for DeepSeek models.
 *
 * Hooks CHAT_COMPLETION_PROMPT_READY and rewrites the final prompt array
 * (prompt-plane only; stored chat messages are never modified):
 *
 *  1. standard mode — RL interface restoration: every system message collapses
 *     into the core RL sentence (upstream "standard" mode).
 *  2. persona injection (auto / spec / react / weak) — classify the chat's
 *     first user message, lock the band per chat in chat metadata, then inject
 *     the persona sentence for the detected model family as a marked system
 *     message (upstream "spec" mode).
 *  3. anti-rumination anchors at 8/20/36 messages back from the window end
 *     (DeepSeek Pro/Flash families only, as measured upstream).
 *  4. depth-adaptive guidance: fast-convergence (react/weak bands) or
 *     decision-closure (spec band) as the context window drains.
 *
 * Only applies to Chat Completion API sources. Non-DeepSeek models are left
 * untouched unless "apply to all models" is enabled; unknown DeepSeek ids
 * (deepseek-chat / deepseek-reasoner / v3.x) route with the core persona.
 */
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { t } from '../../../i18n.js';
import {
    appendUserAnchor,
    buildGuidance,
    classifyTask,
    corePersona,
    modelFamily,
    personaFor,
    replaceSystemWithCore,
} from './router-core.js';

const MODULE_NAME = 'st-deepseek-router';
const PERSONA_MSG_NAME = 'dsh_router';
const GUIDE_MSG_NAME = 'dsh_router_guide';
const METADATA_KEY = 'dsh_router_state';
const ANCHOR_OFFSETS = [36, 20, 8];

/** Chinese-first UI labels; en locale overrides come from locales/en.json. */
const MODE_LABELS = {
    auto: '自动',
    spec: '深度（spec）',
    react: '快循环（react）',
    weak: '轻任务（weak）',
    standard: 'RL 接口还原',
};
const TASK_LABELS = { spec: '深度', react: '快循环', weak: '轻任务' };

const DEFAULT_SETTINGS = {
    /** Master switch: gates every router effect. */
    enabled: true,
    /** auto | spec | react | weak | standard */
    mode: 'auto',
    /** Persona system-message position: first message, or after the leading system block. */
    injectPosition: 'first',
    anchorsEnabled: true,
    guidanceEnabled: true,
    /** Route even when the model id is not DeepSeek-shaped. */
    applyToAllModels: false,
    /** Per-band persona overrides; empty string = upstream built-in for the family. */
    personaOverrides: { spec: '', react: '', weak: '' },
};

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];
    // Pre-0.1.2: "off" lived in the mode dropdown; migrate it to the master switch.
    if (settings.mode === 'off') {
        settings.mode = 'auto';
        settings.enabled = false;
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(DEFAULT_SETTINGS[key]);
    }
    settings.personaOverrides = { ...DEFAULT_SETTINGS.personaOverrides, ...(settings.personaOverrides || {}) };
}

// ---------------------------------------------------------------------------
// Per-chat routing state (chat metadata)
// ---------------------------------------------------------------------------

function getRoutingState() {
    const context = getContext();
    return context.metadata?.[METADATA_KEY] ?? null;
}

function setRoutingState(state) {
    const context = getContext();
    context.metadata = context.metadata || {};
    if (state) {
        context.metadata[METADATA_KEY] = state;
    } else {
        delete context.metadata[METADATA_KEY];
    }
    saveMetadataDebounced();
}

/**
 * Classify the chat from its first stored user message (prompt examples and
 * system blocks are skipped, so roleplay openings route on their own text).
 * @returns {{ taskKind: 'spec' | 'react' | 'weak', preview: string } | null}
 */
function classifyCurrentChat() {
    const chat = getContext().chat;
    if (!Array.isArray(chat)) return null;
    for (const message of chat) {
        if (message?.is_user && typeof message.mes === 'string' && message.mes.length >= 2) {
            const taskKind = classifyTask(message.mes);
            if (taskKind) {
                return { taskKind, preview: message.mes.slice(0, 80) };
            }
        }
    }
    return null;
}

/**
 * Resolve the active band: manual pin wins; auto locks the first
 * classification into chat metadata (upstream: the router decides once, at
 * the first request, then stops re-deciding).
 * @param {string} modeSetting
 * @returns {'spec' | 'react' | 'weak' | null}
 */
function resolveTaskKind(modeSetting) {
    if (modeSetting === 'spec' || modeSetting === 'react' || modeSetting === 'weak') {
        return modeSetting;
    }
    const locked = getRoutingState();
    if (locked?.taskKind) {
        return locked.taskKind;
    }
    const classified = classifyCurrentChat();
    if (!classified) {
        return null;
    }
    setRoutingState({ taskKind: classified.taskKind, source: 'auto', preview: classified.preview });
    return classified.taskKind;
}

// ---------------------------------------------------------------------------
// Prompt-plane rewriting
// ---------------------------------------------------------------------------

/**
 * Active chat-completion model id, read from the source-specific settings
 * field (`custom_model` for Custom OpenAI-compatible, `${source}_model` for
 * named sources such as deepseek / openrouter / siliconflow). `onlineStatus`
 * holds a connection message rather than the model for chat completion
 * sources and must not be used for model detection.
 * @returns {string}
 */
function currentModelId() {
    const oai = getContext().chatCompletionSettings ?? {};
    return String(oai[`${oai.chat_completion_source}_model`] || oai.custom_model || '');
}

function isRoutableModel(modelId, family) {
    return family !== 'DeepSeekOther' || getSettings().applyToAllModels || /deepseek/i.test(modelId);
}

function resolvePersona(family, taskKind) {
    const override = getSettings().personaOverrides[taskKind]?.trim();
    return override || personaFor(family, taskKind);
}

function stripRouterMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.name === PERSONA_MSG_NAME || messages[i]?.name === GUIDE_MSG_NAME) {
            messages.splice(i, 1);
        }
    }
}

function injectPersona(messages, persona, position) {
    let insertAt = 0;
    if (position === 'after-system') {
        while (insertAt < messages.length && messages[insertAt]?.role === 'system') {
            insertAt++;
        }
    }
    messages.splice(insertAt, 0, { role: 'system', name: PERSONA_MSG_NAME, content: persona });
}

/** Index of the last user message in the final prompt array. */
function lastUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            return i;
        }
    }
    return -1;
}

function applyAnchors(messages, family) {
    const lastIdx = lastUserIndex(messages);
    for (const n of ANCHOR_OFFSETS) {
        const idx = lastIdx - (messages.length - 1 - n);
        if (idx >= 0 && idx < messages.length) {
            appendUserAnchor(messages[idx], n, family);
        }
    }
}

function applyGuidance(messages, taskKind) {
    const guide = buildGuidance(messages, taskKind, lastUserIndex(messages), messages.length);
    if (guide) {
        messages.push({ role: 'system', name: GUIDE_MSG_NAME, content: guide });
    }
}

/**
 * CHAT_COMPLETION_PROMPT_READY handler: rewrites the outgoing message array
 * in place. Fires both for real sends and for dry runs (token counting), so
 * token estimates include the router's injections.
 * @param {{ chat: Array<object>, dryRun: boolean }} eventData
 */
function onPromptReady(eventData) {
    const messages = eventData?.chat;
    if (!Array.isArray(messages) || messages.length === 0) {
        return;
    }
    const settings = getSettings();
    if (!settings.enabled) {
        console.debug('[st-deepseek-router] skipped: master switch off');
        updateStatus();
        return;
    }
    if (getContext().mainAPI !== 'openai') {
        console.debug('[st-deepseek-router] skipped: not a Chat Completion API');
        updateStatus();
        return;
    }

    const modelId = currentModelId();
    const family = modelFamily(modelId);
    if (!isRoutableModel(modelId, family)) {
        console.debug('[st-deepseek-router] skipped: model not routable:', modelId || '(empty)');
        updateStatus();
        return;
    }

    stripRouterMessages(messages);

    if (settings.mode === 'standard') {
        replaceSystemWithCore(messages, corePersona);
        updateStatus();
        return;
    }

    const taskKind = resolveTaskKind(settings.mode);
    if (!taskKind) {
        updateStatus();
        return;
    }

    injectPersona(messages, resolvePersona(family, taskKind), settings.injectPosition);
    if (settings.anchorsEnabled) {
        applyAnchors(messages, family);
    }
    if (settings.guidanceEnabled) {
        applyGuidance(messages, taskKind);
    }
    updateStatus();
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function selected(value) {
    return value ? 'selected' : '';
}

async function addSettingsPanel() {
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'settings', {
        enabledChecked: settings.enabled ? 'checked' : '',
        modeAuto: selected(settings.mode === 'auto'),
        modeSpec: selected(settings.mode === 'spec'),
        modeReact: selected(settings.mode === 'react'),
        modeWeak: selected(settings.mode === 'weak'),
        modeStandard: selected(settings.mode === 'standard'),
        positionFirst: selected(settings.injectPosition === 'first'),
        positionAfterSystem: selected(settings.injectPosition === 'after-system'),
        anchorsChecked: settings.anchorsEnabled ? 'checked' : '',
        guidanceChecked: settings.guidanceEnabled ? 'checked' : '',
        allModelsChecked: settings.applyToAllModels ? 'checked' : '',
        personaSpec: settings.personaOverrides.spec,
        personaReact: settings.personaOverrides.react,
        personaWeak: settings.personaOverrides.weak,
    });
    $('#extensions_settings2').append(html);

    $('#dsh_router_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateStatus();
    });
    $('#dsh_router_mode').on('change', function () {
        getSettings().mode = String($(this).val());
        saveSettingsDebounced();
        updateStatus();
    });
    $('#dsh_router_position').on('change', function () {
        getSettings().injectPosition = String($(this).val());
        saveSettingsDebounced();
    });
    $('#dsh_router_anchors').on('change', function () {
        getSettings().anchorsEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#dsh_router_guidance').on('change', function () {
        getSettings().guidanceEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#dsh_router_all_models').on('change', function () {
        getSettings().applyToAllModels = $(this).prop('checked');
        saveSettingsDebounced();
        updateStatus();
    });
    for (const band of ['spec', 'react', 'weak']) {
        $(`#dsh_router_persona_${band}`).on('input', function () {
            getSettings().personaOverrides[band] = String($(this).val());
            saveSettingsDebounced();
            updateStatus();
        });
    }
    $('#dsh_router_reclassify').on('click', () => {
        setRoutingState(null);
        updateStatus();
        toastr.info('路由状态已清除，下次生成时将重新分类本聊天。', 'DeepSeek Router');
    });
    $('#dsh_router_reset').on('click', () => {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        saveSettingsDebounced();
        location.reload();
    });
}

/** Refresh the panel's status line from the current chat and model. */
function updateStatus() {
    const $family = $('#dsh_router_status_family');
    const $task = $('#dsh_router_status_task');
    const $persona = $('#dsh_router_status_persona');
    if (!$family.length) {
        return;
    }
    const settings = getSettings();
    const modelId = currentModelId();
    const family = modelFamily(modelId);
    const routable = settings.enabled && getContext().mainAPI === 'openai' && isRoutableModel(modelId, family);

    const $badge = $('#dsh_router_header_state');
    $badge.text(settings.enabled ? t`启用中` : t`已停用`);
    $badge.toggleClass('on', settings.enabled);
    $badge.toggleClass('off', !settings.enabled);

    $family.text(family);

    let taskKind = null;
    let taskLabel = '—';
    let sourceLabel = '';
    if (settings.mode === 'spec' || settings.mode === 'react' || settings.mode === 'weak') {
        taskKind = settings.mode;
        taskLabel = TASK_LABELS[settings.mode];
        sourceLabel = '手动';
    } else if (settings.mode === 'auto') {
        const locked = getRoutingState();
        taskKind = locked?.taskKind ?? null;
        taskLabel = locked ? TASK_LABELS[locked.taskKind] ?? '—' : '—';
        sourceLabel = locked ? '自动 · 已锁定' : '自动 · 待分类';
    }
    const routeText = !settings.enabled
        ? t`已停用`
        : getContext().mainAPI !== 'openai'
            ? t`未生效·接口非 Chat Completion`
            : routable
                ? `${MODE_LABELS[settings.mode]}｜${taskLabel}｜${sourceLabel}`
                : `${t`未生效`}·${modelId || '—'}`;
    $task.text(routeText);

    let persona = '—';
    if (routable && taskKind) {
        persona = settings.mode === 'standard' ? corePersona : resolvePersona(family, taskKind);
    }
    $persona.text(persona);
}

jQuery(async () => {
    loadSettings();
    await addSettingsPanel();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.CHAT_CHANGED, updateStatus);
    updateStatus();
});
