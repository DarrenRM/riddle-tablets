import {
    getActivePresentation,
    getPreviewPresentation,
    getTopicPresentation,
    listPresentations,
    listTopics
} from './tablet-api.js';
import {
    loadRevealedTabletIds,
    loadSolvedGroupIds,
    setGroupSolved,
    setTabletRevealed
} from './tablet-store.js';
import { flickerGlyphText, inscribeText } from './tablet-reveal.js';

document.addEventListener('DOMContentLoaded', () => {
    const waiting = document.getElementById('waiting-state');
    const longleg = document.querySelector('.longleg-sprite');
    const activeSection = document.getElementById('active-topic');
    const activeHeading = document.getElementById('active-topic-heading');
    const grid = document.getElementById('tablet-grid');
    const solveButton = document.getElementById('solve-topic-button');
    const solvedTopics = document.getElementById('solved-topics');
    const errorState = document.getElementById('topic-error');
    const archiveView = document.getElementById('topic-archive');
    const archiveList = document.getElementById('topic-archive-list');
    const celebration = document.getElementById('completion-celebration');
    const completionTitle = document.getElementById('completion-title');
    const completionClose = document.getElementById('completion-close');
    const completionSound = document.getElementById('completion-sound');
    const ancientSound = document.getElementById('ancient-sound');
    const tabletOpenSound = document.getElementById('tablet-open-sound');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const routeParts = window.location.pathname.split('/').filter(Boolean);
    const mode = routeParts[0] === 'archive'
        ? 'archive'
        : (routeParts[0] === 'preview' ? 'preview' : (routeParts[0] === 'topics' ? 'topic' : 'active'));
    const routeId = mode === 'preview' ? routeParts[2] : (mode === 'topic' ? routeParts[1] : null);

    let currentPresentation = { group: null, tablets: [] };
    let availablePresentations = [];
    let currentSignature = '';
    let stopLayouts = () => {};
    let celebrationInProgress = false;
    let activeCelebration = null;
    let longlegIdleTimer = 0;
    let longlegHeartTimer = 0;
    let presentationLoadVersion = 0;
    let activeRefreshInFlight = false;

    const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    const scrambleCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const ancientTracks = [
        '/audio/noita-ancient-01.mp3?v=1',
        '/audio/noita-ancient-02.mp3?v=1'
    ];
    const CELEBRATION_HOLD_MS = 10000;
    const CELEBRATION_FADE_MS = 1200;
    const SCRAMBLE_START_DELAY_MS = 2200;
    const SCRAMBLE_ROLLS = 12;
    const SCRAMBLE_STEP_MS = 58;
    const SCRAMBLE_STAGGER_MS = 80;

    function stopLonglegCycle() {
        window.clearTimeout(longlegIdleTimer);
        window.clearTimeout(longlegHeartTimer);
        longlegIdleTimer = 0;
        longlegHeartTimer = 0;
        longleg.classList.remove('hearting');
    }

    function startLonglegCycle() {
        stopLonglegCycle();
        if (reduceMotion) return;
        const scheduleHearts = () => {
            longlegIdleTimer = window.setTimeout(() => {
                longleg.classList.add('hearting');
                longlegHeartTimer = window.setTimeout(() => {
                    longleg.classList.remove('hearting');
                    if (!waiting.classList.contains('hidden')) scheduleHearts();
                }, 3000);
            }, 7000);
        };
        scheduleHearts();
    }

    function setCompletionWord(word) {
        completionTitle.textContent = word;
        completionTitle.setAttribute('aria-label', word);
    }

    async function morphCompletionWord(from, to) {
        if (reduceMotion) {
            setCompletionWord(to);
            return;
        }
        const source = Array.from(from);
        const target = Array.from(to);
        const slots = Math.max(source.length, target.length);
        const sourceOffset = Math.floor((slots - source.length) / 2);
        const targetOffset = Math.floor((slots - target.length) / 2);
        const letters = Array.from({ length: slots }, (_, index) => {
            const letter = document.createElement('span');
            letter.className = 'completion-letter';
            letter.setAttribute('aria-hidden', 'true');
            const sourceCharacter = source[index - sourceOffset] || ' ';
            letter.textContent = sourceCharacter === ' ' ? '\u00a0' : sourceCharacter;
            return letter;
        });
        completionTitle.replaceChildren(...letters);
        completionTitle.classList.add('rolling');

        await Promise.all(letters.map(async (letter, index) => {
            await delay(index * SCRAMBLE_STAGGER_MS);
            for (let roll = 0; roll < SCRAMBLE_ROLLS; roll += 1) {
                if (roll > 0 || letter.textContent.trim()) {
                    letter.textContent = scrambleCharacters[Math.floor(Math.random() * scrambleCharacters.length)];
                }
                await delay(SCRAMBLE_STEP_MS);
            }
            const character = target[index - targetOffset];
            letter.textContent = character || '\u00a0';
            letter.style.opacity = character ? '1' : '0';
        }));

        completionTitle.classList.remove('rolling');
        setCompletionWord(to);
    }

    function stopAudio(audio) {
        audio.pause();
        audio.currentTime = 0;
    }

    function playAncientTrack(session) {
        if (activeCelebration !== session || session.dismissed) return;
        ancientSound.src = session.ancientTrack;
        ancientSound.currentTime = 0;
        ancientSound.volume = 0.31;
        ancientSound.play().catch(() => {});
    }

    function fadeAncientTrack(session) {
        if (activeCelebration !== session || session.dismissed) return;
        const startingVolume = ancientSound.volume;
        const startedAt = performance.now();
        const fade = (now) => {
            if (activeCelebration !== session || session.dismissed) return;
            const progress = Math.min(1, (now - startedAt) / CELEBRATION_FADE_MS);
            ancientSound.volume = startingVolume * (1 - progress);
            if (progress < 1) session.audioFadeFrame = window.requestAnimationFrame(fade);
        };
        session.audioFadeFrame = window.requestAnimationFrame(fade);
    }

    function makeCelebrationDismissible(session) {
        if (activeCelebration !== session || session.dismissed) return;
        celebration.classList.add('dismissible');
        session.audioFadeTimer = window.setTimeout(
            () => fadeAncientTrack(session),
            CELEBRATION_HOLD_MS - CELEBRATION_FADE_MS
        );
        session.autoDismissTimer = window.setTimeout(() => dismissCelebration(), CELEBRATION_HOLD_MS);
    }

    async function dismissCelebration() {
        const session = activeCelebration;
        if (!session || session.dismissed || !celebration.classList.contains('dismissible')) return;
        session.dismissed = true;
        activeCelebration = null;
        if (session.autoDismissTimer) window.clearTimeout(session.autoDismissTimer);
        if (session.audioFadeTimer) window.clearTimeout(session.audioFadeTimer);
        if (session.audioFadeFrame) window.cancelAnimationFrame(session.audioFadeFrame);
        if (session.deathEndedHandler) completionSound.removeEventListener('ended', session.deathEndedHandler);
        stopAudio(completionSound);
        stopAudio(ancientSound);
        celebration.classList.remove('visible', 'dismissible');
        await delay(reduceMotion ? 10 : 300);
        celebration.setAttribute('aria-hidden', 'true');
        celebration.removeAttribute('data-phase');
        completionTitle.classList.remove('rolling', 'success');
        celebrationInProgress = false;
    }

    async function celebrateCompletion() {
        const group = currentPresentation.group;
        if (!group || celebrationInProgress) return;
        celebrationInProgress = true;
        stopAudio(tabletOpenSound);
        setGroupSolved(group.id, true);
        renderPresentation();

        const session = {
            dismissed: false,
            deathEndedHandler: null,
            autoDismissTimer: 0,
            audioFadeTimer: 0,
            audioFadeFrame: 0,
            ancientTrack: ancientTracks[Math.random() < 0.5 ? 0 : 1]
        };
        const showGameOver = Math.random() < 0.2;
        activeCelebration = session;
        celebration.classList.remove('dismissible');
        completionTitle.classList.remove('rolling', 'success');
        celebration.setAttribute('aria-hidden', 'false');
        celebration.classList.add('visible');

        if (!showGameOver) {
            setCompletionWord('Success');
            completionTitle.classList.add('success');
            celebration.dataset.phase = 'success';
            playAncientTrack(session);
            await delay(reduceMotion ? 0 : 520);
            makeCelebrationDismissible(session);
            return;
        }

        setCompletionWord('Game Over');
        celebration.dataset.phase = 'game-over';
        session.deathEndedHandler = () => playAncientTrack(session);
        completionSound.addEventListener('ended', session.deathEndedHandler, { once: true });
        completionSound.currentTime = 0;
        completionSound.volume = 0.72;
        completionSound.play().catch(() => playAncientTrack(session));

        await delay(reduceMotion ? 350 : SCRAMBLE_START_DELAY_MS);
        if (activeCelebration !== session || session.dismissed) return;
        celebration.dataset.phase = 'scrambling';
        await morphCompletionWord('Game Over', '(not really)');
        if (activeCelebration !== session || session.dismissed) return;
        completionTitle.classList.add('success');
        celebration.dataset.phase = 'success';
        makeCelebrationDismissible(session);
    }

    completionClose.addEventListener('click', dismissCelebration);
    celebration.addEventListener('click', dismissCelebration);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dismissCelebration();
    });

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
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;
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

    function updateSolveVisibility() {
        const group = currentPresentation.group;
        const anyRevealed = currentPresentation.tablets.some((tablet) => loadRevealedTabletIds().has(tablet.id));
        solveButton.classList.toggle('hidden', mode === 'preview' || !group || !anyRevealed || loadSolvedGroupIds().has(group.id));
    }

    function createTablet(tablet, wasRevealed) {
        const card = document.createElement('article');
        card.className = `riddle-tablet${wasRevealed ? ' revealed' : ''}`;
        card.setAttribute('aria-expanded', String(wasRevealed));

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'tablet-toggle';
        toggle.setAttribute('aria-expanded', String(wasRevealed));

        const seal = document.createElement('span');
        seal.className = 'tablet-seal';
        seal.textContent = '\u2726';
        seal.setAttribute('aria-hidden', 'true');

        const kicker = document.createElement('span');
        kicker.className = 'tablet-kicker riddle-author';
        kicker.textContent = 'Inscribed by';

        const author = document.createElement('span');
        author.className = 'riddle-topic riddle-author-name';
        author.textContent = tablet.author;

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
        toggle.append(seal, kicker, author, reveal);

        const prompt = document.createElement('button');
        prompt.type = 'button';
        prompt.className = 'tablet-open-prompt';
        card.append(toggle, prompt);

        const setExpanded = (expanded) => {
            card.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-label', `${expanded ? 'Close' : 'Open'} clue by ${tablet.author}`);
            prompt.textContent = expanded ? 'Close tablet' : 'Reveal tablet';
        };

        const openTablet = () => {
            if (card.classList.contains('revealed') || card.classList.contains('revealing')) return;
            stopAudio(tabletOpenSound);
            tabletOpenSound.volume = 0.55;
            tabletOpenSound.play().catch(() => {});
            setTabletRevealed(tablet.id, true);
            card.classList.add('revealing');
            setExpanded(true);
            prompt.textContent = 'The tablet awakens...';
            prompt.disabled = true;
            inscribeText(riddle, tablet.riddle, { delay: 260, duration: 1500 });
            updateSolveVisibility();
            window.setTimeout(() => {
                if (!card.isConnected) return;
                card.classList.remove('revealing');
                card.classList.add('revealed');
                prompt.disabled = false;
                setExpanded(true);
            }, reduceMotion ? 0 : 1850);
        };

        const closeTablet = () => {
            if (!card.classList.contains('revealed')) return;
            card.classList.remove('revealed');
            setExpanded(false);
            setTabletRevealed(tablet.id, false);
            updateSolveVisibility();
            window.setTimeout(() => {
                if (!card.classList.contains('revealed') && !card.classList.contains('revealing')) riddle.replaceChildren();
            }, reduceMotion ? 0 : 620);
        };

        card.addEventListener('click', (event) => {
            if (event.target instanceof Element && event.target.closest('.tablet-open-prompt')) return;
            if (card.classList.contains('revealing')) return;
            if (card.classList.contains('revealed')) closeTablet();
            else openTablet();
        });
        prompt.addEventListener('click', () => {
            if (card.classList.contains('revealing')) return;
            if (card.classList.contains('revealed')) closeTablet();
            else openTablet();
        });

        setExpanded(wasRevealed);
        const flickerEvery = 6000;
        const flickerOffset = tablet.id.split('').reduce((total, character) => total + character.charCodeAt(0), 0) % 1200;
        if (!reduceMotion) {
            window.setTimeout(() => {
                if (!card.isConnected) return;
                flickerGlyphText(author, tablet.author);
                const interval = window.setInterval(() => {
                    if (!card.isConnected) window.clearInterval(interval);
                    else flickerGlyphText(author, tablet.author);
                }, flickerEvery);
            }, flickerEvery + flickerOffset);
        }
        return card;
    }

    function hidePresentationViews() {
        stopLonglegCycle();
        waiting.classList.add('hidden');
        activeSection.classList.add('hidden');
        solvedTopics.classList.add('hidden');
        errorState.classList.add('hidden');
        archiveView.classList.add('hidden');
    }

    function createSolvedSection(presentation, revealed) {
        const section = document.createElement('section');
        section.className = 'topic-section solved-topic';
        section.setAttribute('aria-labelledby', `solved-topic-heading-${presentation.group.id}`);

        const heading = document.createElement('h2');
        heading.id = `solved-topic-heading-${presentation.group.id}`;
        heading.className = 'topic-heading';
        heading.textContent = `Solved: ${presentation.group.topic}`;

        const solvedGrid = document.createElement('div');
        solvedGrid.className = 'tablet-grid';
        const cards = presentation.tablets.map((tablet) => createTablet(tablet, revealed.has(tablet.id)));
        solvedGrid.replaceChildren(...cards);
        section.append(heading, solvedGrid);
        return { section, solvedGrid, cards };
    }

    function renderPresentation() {
        stopLayouts();
        hidePresentationViews();
        grid.replaceChildren();
        solvedTopics.replaceChildren();
        grid.classList.remove('masonry-ready');
        grid.style.height = '';

        const { group, tablets } = currentPresentation;
        const revealed = loadRevealedTabletIds();
        const solvedIds = loadSolvedGroupIds();
        const currentSolved = Boolean(group && mode !== 'preview' && solvedIds.has(group.id));
        const layouts = [];

        if (!group || (mode === 'active' && currentSolved)) {
            waiting.classList.remove('hidden');
            document.title = 'Hamis Waits · Riddle Tablets';
        } else if (currentSolved) {
            document.title = `${group.topic} · Riddle Tablets`;
        } else if (!currentSolved) {
            document.title = `${group.topic} · Riddle Tablets`;
            const cards = tablets.map((tablet) => createTablet(tablet, revealed.has(tablet.id)));
            activeHeading.textContent = group.topic;
            grid.replaceChildren(...cards);
            activeSection.classList.remove('hidden');
            if (cards.length) layouts.push(installMasonry(grid, cards));
            updateSolveVisibility();
        }

        if (mode !== 'preview') {
            const byId = new Map(availablePresentations
                .filter((presentation) => presentation.group)
                .map((presentation) => [presentation.group.id, presentation]));
            if (group) byId.set(group.id, currentPresentation);
            const solved = [...byId.values()].filter((presentation) => solvedIds.has(presentation.group.id));
            const rendered = solved.map((presentation) => createSolvedSection(presentation, revealed));
            solvedTopics.replaceChildren(...rendered.map(({ section }) => section));
            solvedTopics.classList.toggle('hidden', rendered.length === 0);
            rendered.forEach(({ solvedGrid, cards }) => {
                if (cards.length) layouts.push(installMasonry(solvedGrid, cards));
            });
        }

        stopLayouts = () => layouts.forEach((stop) => stop());
        if (!waiting.classList.contains('hidden')) startLonglegCycle();
    }

    async function renderArchive() {
        hidePresentationViews();
        archiveView.classList.remove('hidden');
        try {
            const topics = (await listTopics()).filter((topic) => topic.status === 'archived');
            if (!topics.length) {
                const empty = document.createElement('p');
                empty.className = 'topic-archive-empty';
                empty.textContent = 'No topics have been archived yet.';
                archiveList.replaceChildren(empty);
                return;
            }
            archiveList.replaceChildren(...topics.map((topic) => {
                const link = document.createElement('a');
                link.className = 'topic-archive-card';
                link.href = `/topics/${encodeURIComponent(topic.id)}`;
                const label = document.createElement('span');
                label.textContent = 'Solved topic';
                const title = document.createElement('strong');
                title.textContent = topic.topic;
                const count = document.createElement('small');
                count.textContent = `${topic.tabletCount} clue${topic.tabletCount === 1 ? '' : 's'}`;
                link.append(label, title, count);
                return link;
            }));
        } catch {
            archiveList.textContent = 'The archive could not be reached.';
        }
    }

    function signature(presentation, presentations = availablePresentations) {
        return JSON.stringify({
            group: presentation.group && [presentation.group.id, presentation.group.updatedAt],
            tablets: (presentation.tablets || []).map((tablet) => [tablet.id, tablet.updatedAt, tablet.position]),
            available: presentations.map((item) => ({
                group: item.group && [item.group.id, item.group.updatedAt],
                tablets: (item.tablets || []).map((tablet) => [tablet.id, tablet.updatedAt, tablet.position])
            }))
        });
    }

    async function loadPresentation({ quiet = false } = {}) {
        const loadVersion = ++presentationLoadVersion;
        try {
            let result;
            let nextAvailablePresentations = [];
            if (mode === 'active') {
                nextAvailablePresentations = await listPresentations();
                result = nextAvailablePresentations.find((presentation) => presentation.group && presentation.group.status === 'active')
                    || { group: null, tablets: [] };
            } else {
                result = mode === 'preview'
                    ? await getPreviewPresentation(routeId)
                    : await getTopicPresentation(routeId);
            }
            if (loadVersion !== presentationLoadVersion) return;
            const nextSignature = signature(result, nextAvailablePresentations);
            if (quiet && nextSignature === currentSignature) return;
            availablePresentations = nextAvailablePresentations;
            currentSignature = nextSignature;
            currentPresentation = {
                group: result.group || null,
                tablets: Array.isArray(result.tablets) ? result.tablets : []
            };
            renderPresentation();
        } catch {
            if (loadVersion !== presentationLoadVersion) return;
            if (quiet) return;
            hidePresentationViews();
            errorState.classList.remove('hidden');
        }
    }

    async function refreshIfActiveChanged() {
        if (waiting.classList.contains('hidden') || activeRefreshInFlight) return;
        activeRefreshInFlight = true;
        try {
            const result = await getActivePresentation();
            const nextId = result.group ? result.group.id : null;
            const currentId = currentPresentation.group ? currentPresentation.group.id : null;
            if (nextId !== currentId) await loadPresentation({ quiet: true });
        } catch {}
        finally {
            activeRefreshInFlight = false;
        }
    }

    solveButton.addEventListener('click', celebrateCompletion);

    if (mode === 'archive') renderArchive();
    else {
        loadPresentation();
        if (mode === 'active') {
            window.setInterval(refreshIfActiveChanged, 3000);
            window.setInterval(() => loadPresentation({ quiet: true }), 30000);
        }
    }
});
