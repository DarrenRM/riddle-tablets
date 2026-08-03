const LEGACY_STORAGE_KEY = 'noita-riddle-tablets.v1';
const REVEAL_STORAGE_KEY = 'riddle-tablet-reveals.v1';
const COMPLETE_STORAGE_KEY = 'riddle-tablet-completions.v1';

function clean(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
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
    try {
        const ids = JSON.parse(localStorage.getItem(REVEAL_STORAGE_KEY) || '[]');
        return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    } catch {
        return new Set();
    }
}

export function markTabletRevealed(id) {
    setTabletRevealed(id, true);
}

export function setTabletRevealed(id, isRevealed) {
    if (typeof id !== 'string' || !id) return;
    const ids = loadRevealedTabletIds();
    if (isRevealed) ids.add(id);
    else ids.delete(id);
    localStorage.setItem(REVEAL_STORAGE_KEY, JSON.stringify([...ids]));
}

export function loadCompletedTabletIds() {
    try {
        const ids = JSON.parse(localStorage.getItem(COMPLETE_STORAGE_KEY) || '[]');
        return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    } catch {
        return new Set();
    }
}

export function setTabletCompleted(id, isCompleted) {
    if (typeof id !== 'string' || !id) return;
    const ids = loadCompletedTabletIds();
    if (isCompleted) ids.add(id);
    else ids.delete(id);
    localStorage.setItem(COMPLETE_STORAGE_KEY, JSON.stringify([...ids]));
}
