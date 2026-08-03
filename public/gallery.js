import { listTablets } from './tablet-api.js';
import { loadRevealedTabletIds, setTabletRevealed } from './tablet-store.js';
import { flickerGlyphText, inscribeText } from './tablet-reveal.js';

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('tablet-grid');
    const empty = document.getElementById('archive-empty');

    function createTablet(tablet, wasRevealed) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `riddle-tablet${wasRevealed ? ' revealed' : ''}`;
        card.setAttribute('aria-expanded', String(wasRevealed));

        const seal = document.createElement('span');
        seal.className = 'tablet-seal';
        seal.textContent = '\u2726';
        seal.setAttribute('aria-hidden', 'true');

        const author = document.createElement('span');
        author.className = 'tablet-kicker riddle-author';
        const authorLabel = document.createElement('span');
        authorLabel.className = 'riddle-author-label';
        authorLabel.textContent = 'Inscribed by ';
        const authorName = document.createElement('span');
        authorName.className = 'riddle-author-name';
        authorName.textContent = tablet.author;
        author.append(authorLabel, authorName);

        const topic = document.createElement('span');
        topic.className = 'riddle-topic';
        topic.textContent = tablet.topic;

        const reveal = document.createElement('span');
        reveal.className = 'riddle-reveal';
        const revealInner = document.createElement('span');
        revealInner.className = 'riddle-reveal-inner';
        const divider = document.createElement('span');
        divider.className = 'tablet-divider';
        divider.setAttribute('aria-hidden', 'true');
        const dividerMark = document.createElement('span');
        dividerMark.textContent = '\u2726';
        divider.appendChild(dividerMark);
        const riddle = document.createElement('span');
        riddle.className = 'riddle-text';
        if (wasRevealed) riddle.textContent = tablet.riddle;
        revealInner.append(divider, riddle);
        reveal.appendChild(revealInner);

        const prompt = document.createElement('span');
        prompt.className = 'tablet-open-prompt';
        prompt.textContent = 'Awaken inscription';
        card.append(seal, author, topic, reveal, prompt);

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const flickerEvery = 6000;
        const flickerOffset = tablet.id.split('').reduce(
            (total, character) => total + character.charCodeAt(0),
            0
        ) % 1200;
        const flicker = () => {
            if (!card.classList.contains('revealed') && !card.classList.contains('revealing')) {
                flickerGlyphText(topic, tablet.topic);
            }
        };
        if (!reduceMotion) {
            window.setTimeout(() => {
                flicker();
                window.setInterval(flicker, flickerEvery);
            }, flickerEvery + flickerOffset);
        }

        card.addEventListener('click', () => {
            if (card.classList.contains('revealing')) return;

            if (card.classList.contains('revealed')) {
                card.classList.remove('revealed');
                card.setAttribute('aria-expanded', 'false');
                setTabletRevealed(tablet.id, false);
                window.setTimeout(() => {
                    if (!card.classList.contains('revealed') && !card.classList.contains('revealing')) {
                        riddle.replaceChildren();
                    }
                }, reduceMotion ? 0 : 620);
                return;
            }

            setTabletRevealed(tablet.id, true);
            card.classList.add('revealing');
            card.setAttribute('aria-expanded', 'true');
            prompt.textContent = 'The tablet awakens...';
            inscribeText(riddle, tablet.riddle, { delay: 260, duration: 1500 });
            window.setTimeout(() => {
                card.classList.remove('revealing');
                card.classList.add('revealed');
                prompt.textContent = 'Awaken inscription';
            }, reduceMotion ? 0 : 1850);
        });
        return card;
    }

    async function render() {
        try {
            const tablets = await listTablets();
            const revealed = loadRevealedTabletIds();
            grid.replaceChildren(...tablets.map((tablet) => createTablet(tablet, revealed.has(tablet.id))));
            empty.classList.toggle('hidden', tablets.length > 0);
            grid.classList.toggle('hidden', tablets.length === 0);
        } catch {
            grid.replaceChildren();
            empty.classList.remove('hidden');
            empty.querySelector('h1').textContent = 'The tablets could not be summoned';
            empty.querySelector('p').textContent = 'Return when the archive is reachable.';
        }
    }

    render();
});
