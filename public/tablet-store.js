const LEGACY_STORAGE_KEY = 'noita-riddle-tablets.v1';
const REVEAL_STORAGE_KEY = 'riddle-tablet-reveals.v1';
const LEGACY_COMPLETE_STORAGE_KEY = 'riddle-tablet-completions.v1';
export const SOLVED_GROUP_STORAGE_KEY = 'riddle-topic-groups-solved.v1';
export const QUEST_PROGRESS_STORAGE_KEY = 'riddle-topic-quest-progress.v1';
export const MAIN_RIDDLE_NAMES_HIDDEN_STORAGE_KEY = 'riddle-main-topic-names-hidden.v1';

function clean(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function loadIds(key) {
    try {
        const ids = JSON.parse(localStorage.getItem(key) || '[]');
        return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    } catch {
        return new Set();
    }
}

function saveIds(key, ids) {
    try {
        localStorage.setItem(key, JSON.stringify([...ids]));
    } catch {}
}

function questSignature(tabletIds, questRevision) {
    return JSON.stringify({
        revision: Math.max(0, Math.trunc(Number(questRevision) || 0)),
        tabletIds: Array.isArray(tabletIds) ? tabletIds.filter((id) => typeof id === 'string' && id) : []
    });
}

function loadQuestProgress() {
    try {
        const parsed = JSON.parse(localStorage.getItem(QUEST_PROGRESS_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveQuestProgress(progress) {
    try {
        localStorage.setItem(QUEST_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
    } catch {}
}

export function loadLegacyTablets() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.map((value) => ({
            id: clean(value && value.id, 120),
            topic: clean(value && value.topic, 120),
            author: clean(value && value.author, 120),
            riddle: clean(value && value.riddle, 2000)
        })).filter((value) => value.id && value.topic && value.author && value.riddle);
    } catch {
        return [];
    }
}

export function clearLegacyTablets() {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function loadRevealedTabletIds() {
    return loadIds(REVEAL_STORAGE_KEY);
}

export function markTabletRevealed(id) {
    setTabletRevealed(id, true);
}

export function setTabletRevealed(id, isRevealed) {
    if (typeof id !== 'string' || !id) return;
    const ids = loadRevealedTabletIds();
    if (isRevealed) ids.add(id);
    else ids.delete(id);
    saveIds(REVEAL_STORAGE_KEY, ids);
}

export function loadSolvedGroupIds() {
    return loadIds(SOLVED_GROUP_STORAGE_KEY);
}

export function setGroupSolved(id, isSolved) {
    if (typeof id !== 'string' || !id) return;
    const ids = loadSolvedGroupIds();
    if (isSolved) ids.add(id);
    else ids.delete(id);
    saveIds(SOLVED_GROUP_STORAGE_KEY, ids);
}

export function loadMainRiddleNamesHidden() {
    try {
        return localStorage.getItem(MAIN_RIDDLE_NAMES_HIDDEN_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setMainRiddleNamesHidden(isHidden) {
    try {
        localStorage.setItem(MAIN_RIDDLE_NAMES_HIDDEN_STORAGE_KEY, String(Boolean(isHidden)));
    } catch {}
}

export function loadQuestCompletedStepCount(groupId, tabletIds, questRevision) {
    if (typeof groupId !== 'string' || !groupId) return 0;
    const entry = loadQuestProgress()[groupId];
    const signature = questSignature(tabletIds, questRevision);
    if (!entry || entry.signature !== signature) return 0;
    const completed = Math.max(0, Math.trunc(Number(entry.completed) || 0));
    return Math.min(completed, Array.isArray(tabletIds) ? tabletIds.length : 0);
}

export function setQuestCompletedStepCount(groupId, tabletIds, completed, questRevision) {
    if (typeof groupId !== 'string' || !groupId) return;
    const progress = loadQuestProgress();
    const count = Math.max(0, Math.min(
        Math.trunc(Number(completed) || 0),
        Array.isArray(tabletIds) ? tabletIds.length : 0
    ));
    if (count === 0) delete progress[groupId];
    else progress[groupId] = { signature: questSignature(tabletIds, questRevision), completed: count };
    saveQuestProgress(progress);
}

export function resetQuestProgress(groupId) {
    if (typeof groupId !== 'string' || !groupId) return;
    const progress = loadQuestProgress();
    if (!Object.prototype.hasOwnProperty.call(progress, groupId)) return;
    delete progress[groupId];
    saveQuestProgress(progress);
}

// Retained only so old browser bundles do not fail while caches expire.
export function loadCompletedTabletIds() {
    return loadIds(LEGACY_COMPLETE_STORAGE_KEY);
}

export function setTabletCompleted(id, isCompleted) {
    if (typeof id !== 'string' || !id) return;
    const ids = loadCompletedTabletIds();
    if (isCompleted) ids.add(id);
    else ids.delete(id);
    saveIds(LEGACY_COMPLETE_STORAGE_KEY, ids);
}
