function hashText(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededRandom(seed) {
    let state = seed || 1;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

const cipherAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function cipherCharacter(character, random) {
    const original = character.toUpperCase();
    let index = Math.floor(random() * cipherAlphabet.length);
    if (cipherAlphabet[index] === original) index = (index + 1) % cipherAlphabet.length;
    const cipher = cipherAlphabet[index];
    return character !== original && character === character.toLowerCase()
        ? cipher.toLowerCase()
        : cipher;
}

function showGlyphCharacter(span) {
    span.className = 'glyph-char';
    span.textContent = span.dataset.glyphCharacter;
}

function showPixelCharacter(span) {
    span.className = 'pixel-char';
    span.textContent = span.dataset.pixelCharacter;
}

function createRevealOrder(text) {
    const count = Array.from(String(text || '')).filter((character) => !/\s/.test(character)).length;
    const order = Array.from({ length: count }, (_, index) => index);
    const random = seededRandom(hashText(text));
    for (let index = order.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(random() * (index + 1));
        [order[index], order[randomIndex]] = [order[randomIndex], order[index]];
    }
    return order;
}

function buildGlyphText(element, text) {
    element.replaceChildren();
    const spans = [];
    const random = seededRandom(hashText(text) ^ 0x9E3779B9);
    String(text || '').split(/(\s+)/).forEach((token) => {
        if (/^\s+$/.test(token)) {
            element.appendChild(document.createTextNode(token));
            return;
        }
        if (!token) return;
        const word = document.createElement('span');
        word.className = 'word-wrap';
        Array.from(token).forEach((character) => {
            const glyph = document.createElement('span');
            glyph.dataset.pixelCharacter = character;
            glyph.dataset.glyphCharacter = cipherCharacter(character, random);
            showGlyphCharacter(glyph);
            word.appendChild(glyph);
            spans.push(glyph);
        });
        element.appendChild(word);
    });
    return spans;
}

export function renderGlyphText(element, text) {
    const spans = buildGlyphText(element, text);
    spans.forEach(showGlyphCharacter);
}

export function inscribeText(element, text, { delay = 0, duration = 1500 } = {}) {
    const spans = buildGlyphText(element, text);
    const order = createRevealOrder(text);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    order.forEach((index, rank) => {
        const progress = spans.length > 0 ? rank / spans.length : 1;
        window.setTimeout(() => {
            if (spans[index]) showPixelCharacter(spans[index]);
        }, reduceMotion ? 0 : delay + progress * duration);
    });
}

export function concealText(element, text, { duration = 900 } = {}) {
    const spans = buildGlyphText(element, text);
    const order = createRevealOrder(text);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    spans.forEach(showPixelCharacter);
    order.forEach((index, rank) => {
        const progress = spans.length > 0 ? rank / spans.length : 1;
        window.setTimeout(() => {
            if (spans[index]) showGlyphCharacter(spans[index]);
        }, reduceMotion ? 0 : progress * duration);
    });
}

export function flickerGlyphText(element, text, { duration = 700 } = {}) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const spans = buildGlyphText(element, text);
    const order = createRevealOrder(text);
    spans.forEach(showPixelCharacter);
    order.forEach((index, rank) => {
        const progress = order.length > 1 ? rank / (order.length - 1) : 0;
        window.setTimeout(() => {
            if (spans[index]) showGlyphCharacter(spans[index]);
        }, progress * duration * 0.42);
        window.setTimeout(() => {
            if (spans[index]) showPixelCharacter(spans[index]);
        }, duration * 0.58 + progress * duration * 0.42);
    });
}
