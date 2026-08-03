import { listTablets } from './tablet-api.js';
import {
    loadCompletedTabletIds,
    loadRevealedTabletIds,
    setTabletCompleted,
    setTabletRevealed
} from './tablet-store.js';
import { flickerGlyphText, inscribeText } from './tablet-reveal.js';

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('tablet-grid');
    const completedSection = document.getElementById('completed-section');
    const completedGrid = document.getElementById('completed-tablet-grid');
    const empty = document.getElementById('archive-empty');
    let currentTablets = [];
    let stopLayouts = () => {};

    function installMasonry(targetGrid, cards) {
        let animationFrame = 0;

        const columnCount = () => {
            if (window.matchMedia('(max-width: 620px)').matches) return 1;
            if (window.matchMedia('(max-width: 1100px)').matches) return 2;
            return 4;
        };

        const layout = () => {
            animationFrame = 0;
            if (!cards.length || targetGrid.classList.contains('hidden')) return;
            const columns = columnCount();
            const gap = parseFloat(getComputedStyle(targetGrid).columnGap) || 19.2;
            const cardWidth = (targetGrid.clientWidth - gap * (columns - 1)) / columns;
            const columnBottoms = Array(columns).fill(0);

            cards.forEach((card, index) => {
                const column = index % columns;
                card.style.width = `${cardWidth}px`;
                card.style.left = `${column * (cardWidth + gap)}px`;
                card.style.top = `${columnBottoms[column]}px`;
                columnBottoms[column] += card.offsetHeight + gap;
            });

            targetGrid.style.height = `${Math.max(0, ...columnBottoms) - gap}px`;
            targetGrid.classList.add('masonry-ready');
        };

        const scheduleLayout = () => {
            if (!animationFrame) animationFrame = window.requestAnimationFrame(layout);
        };
        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(scheduleLayout)
            : null;
        if (observer) {
            observer.observe(targetGrid);
            cards.forEach((card) => observer.observe(card));
        }
        window.addEventListener('resize', scheduleLayout);
        document.fonts.ready.then(scheduleLayout);
        scheduleLayout();

        return () => {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            if (observer) observer.disconnect();
            window.removeEventListener('resize', scheduleLayout);
        };
    }

    function createTablet(tablet, wasRevealed, isCompleted) {
        const card = document.createElement('article');
        card.className = `riddle-tablet${wasRevealed ? ' revealed' : ''}${isCompleted ? ' completed' : ''}`;
        card.setAttribute('aria-expanded', String(wasRevealed));

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'tablet-toggle';
        toggle.setAttribute('aria-expanded', String(wasRevealed));

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
        toggle.append(seal, author, topic, reveal);

        const prompt = document.createElement('button');
        prompt.type = 'button';
        prompt.className = 'tablet-open-prompt';
        card.append(toggle, prompt);

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const setExpanded = (expanded) => {
            card.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-label', `${expanded ? 'Close' : 'Open'} ${tablet.topic}`);
        };
        const setRestingPrompt = () => {
            prompt.disabled = false;
            if (isCompleted) prompt.textContent = 'Return to active';
            else if (card.classList.contains('revealed')) prompt.textContent = 'Mark as complete';
            else prompt.textContent = 'Awaken inscription';
        };

        const openTablet = () => {
            if (card.classList.contains('revealed') || card.classList.contains('revealing')) return;
            setTabletRevealed(tablet.id, true);
            card.classList.add('revealing');
            setExpanded(true);
            prompt.textContent = 'The tablet awakens...';
            prompt.disabled = true;
            inscribeText(riddle, tablet.riddle, { delay: 260, duration: 1500 });
            window.setTimeout(() => {
                if (!card.isConnected) return;
                card.classList.remove('revealing');
                card.classList.add('revealed');
                setRestingPrompt();
            }, reduceMotion ? 0 : 1850);
        };

        const closeTablet = () => {
            if (!card.classList.contains('revealed')) return;
            card.classList.remove('revealed');
            setExpanded(false);
            setTabletRevealed(tablet.id, false);
            setRestingPrompt();
            window.setTimeout(() => {
                if (!card.classList.contains('revealed') && !card.classList.contains('revealing')) {
                    riddle.replaceChildren();
                }
            }, reduceMotion ? 0 : 620);
        };

        const moveToSection = (completed) => {
            setTabletCompleted(tablet.id, completed);
            prompt.disabled = true;
            card.classList.add('changing-section');
            window.setTimeout(() => renderTablets(currentTablets), reduceMotion ? 0 : 180);
        };

        toggle.addEventListener('click', () => {
            if (card.classList.contains('revealing')) return;
            if (card.classList.contains('revealed')) closeTablet();
            else openTablet();
        });
        prompt.addEventListener('click', () => {
            if (card.classList.contains('revealing')) return;
            if (isCompleted) moveToSection(false);
            else if (card.classList.contains('revealed')) moveToSection(true);
            else openTablet();
        });

        setExpanded(wasRevealed);
        setRestingPrompt();

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
                if (!card.isConnected) return;
                flicker();
                const interval = window.setInterval(() => {
                    if (!card.isConnected) window.clearInterval(interval);
                    else flicker();
                }, flickerEvery);
            }, flickerEvery + flickerOffset);
        }

        return card;
    }

    function renderTablets(tablets) {
        stopLayouts();
        const revealed = loadRevealedTabletIds();
        const completed = loadCompletedTabletIds();
        const activeTablets = tablets.filter((tablet) => !completed.has(tablet.id));
        const completedTablets = tablets.filter((tablet) => completed.has(tablet.id));
        const activeCards = activeTablets.map((tablet) => createTablet(tablet, revealed.has(tablet.id), false));
        const completedCards = completedTablets.map((tablet) => createTablet(tablet, revealed.has(tablet.id), true));

        grid.classList.remove('masonry-ready');
        completedGrid.classList.remove('masonry-ready');
        grid.style.height = '';
        completedGrid.style.height = '';
        grid.replaceChildren(...activeCards);
        completedGrid.replaceChildren(...completedCards);
        grid.classList.toggle('hidden', activeCards.length === 0);
        completedSection.classList.toggle('hidden', completedCards.length === 0);
        empty.classList.toggle('hidden', tablets.length > 0);

        const cleanups = [];
        if (activeCards.length) cleanups.push(installMasonry(grid, activeCards));
        if (completedCards.length) cleanups.push(installMasonry(completedGrid, completedCards));
        stopLayouts = () => cleanups.forEach((cleanup) => cleanup());
    }

    async function render() {
        try {
            currentTablets = await listTablets();
            renderTablets(currentTablets);
        } catch {
            stopLayouts();
            grid.replaceChildren();
            completedGrid.replaceChildren();
            completedSection.classList.add('hidden');
            empty.classList.remove('hidden');
            empty.querySelector('h1').textContent = 'The tablets could not be summoned';
            empty.querySelector('p').textContent = 'Return when the archive is reachable.';
        }
    }

    render();
});
