import { listTablets } from './tablet-api.js';
import { loadRevealedTabletIds, markTabletRevealed } from './tablet-store.js';
import { inscribeText } from './tablet-reveal.js';

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
        seal.textContent = '✦';
        seal.setAttribute('aria-hidden', 'true');
        const author = document.createElement('span');
        author.className = 'tablet-kicker riddle-author';
        author.textContent = `Inscribed by ${tablet.author}`;
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
        dividerMark.textContent = '✦';
        divider.appendChild(dividerMark);
        const riddle = document.createElement('span');
        riddle.className = 'riddle-text';
        if (wasRevealed) riddle.textContent = tablet.riddle;
        revealInner.append(divider, riddle);
        reveal.appendChild(revealInner);
        const prompt = document.createElement('span');
        prompt.className = 'tablet-open-prompt';
        prompt.textContent = wasRevealed ? '' : 'Awaken inscription';
        card.append(seal, author, topic, reveal, prompt);

        card.addEventListener('click', () => {
            if (card.classList.contains('revealed') || card.classList.contains('revealing')) return;
            markTabletRevealed(tablet.id);
            card.classList.add('revealing');
            card.setAttribute('aria-expanded', 'true');
            prompt.textContent = 'The tablet awakens…';
            inscribeText(topic, tablet.topic, { duration: 500 });
            inscribeText(author, `Inscribed by ${tablet.author}`, { delay: 120, duration: 650 });
            inscribeText(riddle, tablet.riddle, { delay: 420, duration: 1500 });
            window.setTimeout(() => {
                card.classList.remove('revealing');
                card.classList.add('revealed');
                prompt.textContent = '';
            }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 2050);
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
