const LEGACY_STORAGE_KEY = 'noita-riddle-tablets.v1';
const REVEAL_STORAGE_KEY = 'riddle-tablet-reveals.v1';
const LEGACY_COMPLETE_STORAGE_KEY = 'riddle-tablet-completions.v1';
export const SOLVED_GROUP_STORAGE_KEY = 'riddle-topic-groups-solved.v1';

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
