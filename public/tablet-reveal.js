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
            glyph.textContent = character;
            glyph.className = 'glyph-char';
            word.appendChild(glyph);
            spans.push(glyph);
        });
        element.appendChild(word);
    });
    return spans;
}

export function inscribeText(element, text, { delay = 0, duration = 1500 } = {}) {
    const spans = buildGlyphText(element, text);
    const order = createRevealOrder(text);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    order.forEach((index, rank) => {
        const progress = spans.length > 0 ? rank / spans.length : 1;
        window.setTimeout(() => {
            if (spans[index]) spans[index].className = 'pixel-char';
        }, reduceMotion ? 0 : delay + progress * duration);
    });
}

export function flickerGlyphText(element, text, { duration = 700 } = {}) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const spans = buildGlyphText(element, text);
    const order = createRevealOrder(text);
    spans.forEach((span) => { span.className = 'pixel-char'; });
    order.forEach((index, rank) => {
        const progress = order.length > 1 ? rank / (order.length - 1) : 0;
        window.setTimeout(() => {
            if (spans[index]) spans[index].className = 'glyph-char';
        }, progress * duration * 0.42);
        window.setTimeout(() => {
            if (spans[index]) spans[index].className = 'pixel-char';
        }, duration * 0.58 + progress * duration * 0.42);
    });
}
