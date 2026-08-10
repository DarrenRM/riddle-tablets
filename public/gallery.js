import {
    getPreviewPresentation,
    getTopicPresentation,
    listArchivePresentations,
    listPresentations
} from './tablet-api.js';
import {
    loadMainRiddleNamesHidden,
    loadRevealedTabletIds,
    loadQuestCompletedStepCount,
    loadSolvedGroupIds,
    QUEST_PROGRESS_STORAGE_KEY,
    MAIN_RIDDLE_NAMES_HIDDEN_STORAGE_KEY,
    resetQuestProgress,
    SOLVED_GROUP_STORAGE_KEY,
    setGroupSolved,
    setMainRiddleNamesHidden,
    setQuestCompletedStepCount,
    setTabletRevealed
} from './tablet-store.js';
import { flickerGlyphText, inscribeText } from './tablet-reveal.js';

document.addEventListener('DOMContentLoaded', () => {
    const waiting = document.getElementById('waiting-state');
    const longleg = document.querySelector('.longleg-sprite');
    const activeTopics = document.getElementById('active-topics');
    const solvedTopics = document.getElementById('solved-topics');
    const errorState = document.getElementById('topic-error');
    const archiveView = document.getElementById('topic-archive');
    const archiveList = document.getElementById('topic-archive-list');
    const hideRiddleNames = document.getElementById('hide-riddle-names');
    const mainRiddleNameControl = document.getElementById('main-riddle-name-control');
    const hideMainRiddleNames = document.getElementById('hide-main-riddle-names');
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

    if (mode === 'active') hideMainRiddleNames.checked = loadMainRiddleNamesHidden();

    let currentPresentations = [];
    let availablePresentations = [];
    let currentSignature = '';
    let stopLayouts = () => {};
    let celebrationInProgress = false;
    let activeCelebration = null;
    let longlegIdleTimer = 0;
    let longlegHeartTimer = 0;
    let presentationLoadVersion = 0;
    let pendingQuestReveal = null;

    function closeSolvedMenus(except = null) {
        document.querySelectorAll('.solved-topic-menu-list:not([hidden])').forEach((menu) => {
            if (menu === except) return;
            menu.hidden = true;
            const toggle = menu.parentElement && menu.parentElement.querySelector('.solved-topic-menu-toggle');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
    }

    document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element) || !event.target.closest('.solved-topic-menu')) closeSolvedMenus();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const menu = document.querySelector('.solved-topic-menu-list:not([hidden])');
        if (!menu) return;
        const toggle = menu.parentElement && menu.parentElement.querySelector('.solved-topic-menu-toggle');
        closeSolvedMenus();
        if (toggle) toggle.focus();
    });

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

    async function celebrateCompletion(groupId) {
        const presentation = currentPresentations.find((candidate) => candidate.group && candidate.group.id === groupId)
            || availablePresentations.find((candidate) => candidate.group && candidate.group.id === groupId);
        const group = presentation && presentation.group;
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
        targetGrid.classList.toggle('single-tablet-grid', cards.length === 1);
        targetGrid.classList.toggle('two-tablet-grid', cards.length === 2);
        targetGrid.classList.toggle('three-tablet-grid', cards.length === 3);
        const columnCount = () => {
            if (window.matchMedia('(max-width: 620px)').matches) return 1;
            if (window.matchMedia('(max-width: 1100px)').matches) return 2;
            return 4;
        };
        const layout = () => {
            animationFrame = 0;
            if (!cards.length || targetGrid.classList.contains('hidden')) return;
            const columns = Math.min(cards.length, columnCount());
            const gap = parseFloat(getComputedStyle(targetGrid).columnGap) || 19.2;
            const cardWidth = (targetGrid.clientWidth - gap * (columns - 1)) / columns;
            const columnBottoms = Array(columns).fill(0);
            const shouldCenterLastRow = cards.length <= 3 && cards.length % columns !== 0;
            const lastRowStart = shouldCenterLastRow ? cards.length - (cards.length % columns) : cards.length;
            let centeredLastRowTop = 0;
            cards.forEach((card, index) => {
                if (index >= lastRowStart) {
                    if (index === lastRowStart) centeredLastRowTop = Math.max(...columnBottoms);
                    const lastRowCount = cards.length - lastRowStart;
                    const rowWidth = lastRowCount * cardWidth + (lastRowCount - 1) * gap;
                    const rowLeft = (targetGrid.clientWidth - rowWidth) / 2;
                    const rowIndex = index - lastRowStart;
                    card.style.width = `${cardWidth}px`;
                    card.style.left = `${rowLeft + rowIndex * (cardWidth + gap)}px`;
                    card.style.top = `${centeredLastRowTop}px`;
                    return;
                }
                const column = index % columns;
                card.style.width = `${cardWidth}px`;
                card.style.left = `${column * (cardWidth + gap)}px`;
                card.style.top = `${columnBottoms[column]}px`;
                columnBottoms[column] += card.offsetHeight + gap;
            });
            const centeredLastRowHeight = shouldCenterLastRow
                ? centeredLastRowTop + Math.max(...cards.slice(lastRowStart).map((card) => card.offsetHeight))
                : 0;
            const masonryHeight = Math.max(0, ...columnBottoms) - gap;
            targetGrid.style.height = `${Math.max(0, centeredLastRowHeight, masonryHeight)}px`;
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

    function createTablet(tablet, wasRevealed, {
        canCompleteTopic = false,
        questState = null,
        stepNumber = 0,
        totalSteps = 0,
        autoReveal = false,
        persistRevealState = true,
        onCompleteStep = () => {},
        onCompleteTopic = () => {},
        onRevealStateChange = () => {}
    } = {}) {
        const isQuestStep = Boolean(questState);
        const isLockedStep = questState === 'locked';
        const isCurrentStep = questState === 'current';
        const isCompletedStep = questState === 'completed';
        if (isLockedStep) wasRevealed = false;
        const card = document.createElement('article');
        card.className = `riddle-tablet${wasRevealed ? ' revealed' : ''}`;
        card.classList.toggle('single-topic-tablet', canCompleteTopic);
        card.classList.toggle('quest-step', isQuestStep);
        card.classList.toggle('quest-step-locked', isLockedStep);
        card.classList.toggle('quest-step-current', isCurrentStep);
        card.classList.toggle('quest-step-completed', isCompletedStep);
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
        kicker.textContent = isQuestStep ? `Step ${stepNumber} of ${totalSteps} · Inscribed by` : 'Inscribed by';

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

        const setPrompt = (expanded) => {
            prompt.classList.remove('single-topic-solve-prompt', 'quest-step-complete-prompt', 'quest-step-locked-prompt');
            if (isLockedStep) {
                prompt.classList.add('quest-step-locked-prompt');
                prompt.textContent = 'Step Locked';
                return;
            }
            if (expanded && isCompletedStep) {
                prompt.classList.add('quest-step-complete-prompt');
                const completeLabel = document.createElement('span');
                completeLabel.className = 'quest-step-complete-label';
                completeLabel.textContent = 'Step Complete';
                const closeLabel = document.createElement('span');
                closeLabel.className = 'quest-step-close-label';
                closeLabel.textContent = 'Close tablet';
                prompt.replaceChildren(completeLabel, closeLabel);
                return;
            }
            prompt.classList.toggle('single-topic-solve-prompt', expanded && (canCompleteTopic || isCurrentStep));
            prompt.textContent = expanded
                ? (isCurrentStep ? 'Mark step complete' : (canCompleteTopic ? 'Mark as Solved' : 'Close tablet'))
                : (isCompletedStep ? 'Review completed step' : 'Reveal tablet');
        };

        const setExpanded = (expanded) => {
            if (isLockedStep) expanded = false;
            card.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-disabled', String(isLockedStep));
            toggle.setAttribute('aria-label', isLockedStep
                ? `Step ${stepNumber} is locked. Complete the previous step first.`
                : `${expanded ? 'Close' : 'Open'} clue by ${tablet.author}`);
            setPrompt(expanded);
            prompt.setAttribute('aria-label', isLockedStep
                ? `Step ${stepNumber} locked`
                : (expanded && isCurrentStep ? `Mark step ${stepNumber} complete` : prompt.textContent));
        };

        const denyLockedStep = () => {
            card.classList.remove('quest-step-denied');
            void card.offsetWidth;
            card.classList.add('quest-step-denied');
            window.setTimeout(() => card.classList.remove('quest-step-denied'), 460);
        };

        const openTablet = () => {
            if (isLockedStep) {
                denyLockedStep();
                return;
            }
            if (card.classList.contains('revealed') || card.classList.contains('revealing')) return;
            stopAudio(tabletOpenSound);
            tabletOpenSound.volume = 0.55;
            tabletOpenSound.play().catch(() => {});
            if (persistRevealState) setTabletRevealed(tablet.id, true);
            card.classList.add('revealing');
            setExpanded(true);
            prompt.textContent = 'The tablet awakens...';
            prompt.disabled = true;
            inscribeText(riddle, tablet.riddle, { delay: 260, duration: 1500 });
            onRevealStateChange();
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
            if (persistRevealState) setTabletRevealed(tablet.id, false);
            onRevealStateChange();
            window.setTimeout(() => {
                if (!card.classList.contains('revealed') && !card.classList.contains('revealing')) riddle.replaceChildren();
            }, reduceMotion ? 0 : 620);
        };

        card.addEventListener('click', (event) => {
            if (event.target instanceof Element && event.target.closest('.tablet-open-prompt')) return;
            if (isLockedStep) {
                denyLockedStep();
                return;
            }
            if (card.classList.contains('revealing')) return;
            if (card.classList.contains('revealed')) closeTablet();
            else openTablet();
        });
        prompt.addEventListener('click', () => {
            if (isLockedStep) {
                denyLockedStep();
                return;
            }
            if (card.classList.contains('revealing')) return;
            if (card.classList.contains('revealed') && isCurrentStep) onCompleteStep();
            else if (card.classList.contains('revealed') && canCompleteTopic) onCompleteTopic();
            else if (card.classList.contains('revealed')) closeTablet();
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
        if (autoReveal && !isLockedStep) {
            window.requestAnimationFrame(() => {
                if (!card.isConnected) return;
                card.classList.add('quest-step-unlocking');
                openTablet();
                window.setTimeout(() => card.classList.remove('quest-step-unlocking'), reduceMotion ? 20 : 2400);
            });
        }
        return card;
    }

    function displayTopic(group) {
        return group && group.multiStep ? `Multi-step: ${group.topic}` : group.topic;
    }

    function renderTopicHeadingName(heading, hidden, animate = false) {
        const topicName = heading.dataset.topicName || '';
        heading.classList.toggle('archive-topic-name-hidden', hidden);
        if (hidden) {
            heading.textContent = topicName;
            heading.setAttribute('aria-label', 'Riddle name hidden');
        } else {
            heading.setAttribute('aria-label', topicName);
            if (animate) inscribeText(heading, topicName, { duration: 1200 });
            else heading.textContent = topicName;
        }
    }

    function applyMainRiddleNamePreference(animate = false) {
        if (mode !== 'active') return;
        document.querySelectorAll('#active-topics .topic-heading, #solved-topics .topic-heading').forEach((heading) => {
            renderTopicHeadingName(heading, hideMainRiddleNames.checked, animate && !hideMainRiddleNames.checked);
        });
    }

    function createTopicSection(presentation, revealed, { allowCompletion = true } = {}) {
        const { group, tablets } = presentation;
        const section = document.createElement('section');
        section.className = 'topic-section active-topic';
        section.dataset.groupId = group.id;
        section.setAttribute('aria-labelledby', `active-topic-heading-${group.id}`);

        const heading = document.createElement('h1');
        heading.id = `active-topic-heading-${group.id}`;
        heading.className = 'topic-heading';
        heading.dataset.topicName = displayTopic(group);
        heading.textContent = heading.dataset.topicName;

        const topicGrid = document.createElement('div');
        topicGrid.className = 'tablet-grid';
        topicGrid.setAttribute('aria-live', 'polite');

        const completionActions = document.createElement('div');
        completionActions.className = 'topic-completion-actions';
        const groupSolveButton = document.createElement('button');
        groupSolveButton.type = 'button';
        groupSolveButton.className = 'solve-topic-button sampo-solve-button hidden';
        groupSolveButton.setAttribute('aria-label', `Mark ${group.topic} as solved`);
        const sampo = document.createElement('img');
        sampo.src = '/images/sampo.png';
        sampo.alt = '';
        sampo.setAttribute('aria-hidden', 'true');
        const solveLabel = document.createElement('span');
        solveLabel.textContent = 'Mark topic as solved';
        groupSolveButton.append(sampo, solveLabel);
        completionActions.appendChild(groupSolveButton);

        const isMultiStepQuest = Boolean(group.multiStep) && mode !== 'preview';
        const tabletIds = tablets.map((tablet) => tablet.id);
        const storedCompletedSteps = isMultiStepQuest
            ? loadQuestCompletedStepCount(group.id, tabletIds, group.questRevision)
            : 0;
        const completedSteps = Math.min(storedCompletedSteps, Math.max(0, tablets.length - 1));
        const autoRevealId = pendingQuestReveal && pendingQuestReveal.groupId === group.id
            ? pendingQuestReveal.tabletId
            : null;
        if (autoRevealId) pendingQuestReveal = null;
        const canCompleteSingleTopic = allowCompletion && tablets.length === 1 && !isMultiStepQuest;
        const updateSolveVisibility = () => {
            const anyRevealed = tablets.some((tablet) => loadRevealedTabletIds().has(tablet.id));
            groupSolveButton.classList.toggle(
                'hidden',
                isMultiStepQuest || !allowCompletion || tablets.length <= 1 || !anyRevealed || loadSolvedGroupIds().has(group.id)
            );
        };
        const completeTopic = () => celebrateCompletion(group.id);
        const completeQuestStep = (index) => {
            const nextCompletedSteps = index + 1;
            setQuestCompletedStepCount(group.id, tabletIds, nextCompletedSteps, group.questRevision);
            if (nextCompletedSteps >= tablets.length) {
                celebrateCompletion(group.id);
                return;
            }
            const nextTablet = tablets[nextCompletedSteps];
            setTabletRevealed(nextTablet.id, false);
            pendingQuestReveal = { groupId: group.id, tabletId: nextTablet.id };
            renderPresentation();
        };
        const cards = tablets.map((tablet, index) => {
            const questState = !isMultiStepQuest
                ? null
                : (index < completedSteps ? 'completed' : (index === completedSteps ? 'current' : 'locked'));
            return createTablet(
                tablet,
                questState === 'locked' ? false : revealed.has(tablet.id),
                {
                    canCompleteTopic: canCompleteSingleTopic,
                    questState,
                    stepNumber: index + 1,
                    totalSteps: tablets.length,
                    autoReveal: tablet.id === autoRevealId,
                    onCompleteStep: () => completeQuestStep(index),
                    onCompleteTopic: completeTopic,
                    onRevealStateChange: updateSolveVisibility
                }
            );
        });
        topicGrid.replaceChildren(...cards);
        groupSolveButton.addEventListener('click', completeTopic);
        section.append(heading, topicGrid, completionActions);
        updateSolveVisibility();
        return { section, topicGrid, cards };
    }

    function hidePresentationViews() {
        stopLonglegCycle();
        waiting.classList.add('hidden');
        activeTopics.classList.add('hidden');
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
        heading.dataset.topicName = `Solved: ${displayTopic(presentation.group)}`;
        heading.textContent = heading.dataset.topicName;

        const headingRow = document.createElement('div');
        headingRow.className = 'solved-topic-heading-row';

        const menu = document.createElement('div');
        menu.className = 'solved-topic-menu';
        const menuToggle = document.createElement('button');
        menuToggle.type = 'button';
        menuToggle.className = 'solved-topic-menu-toggle';
        menuToggle.setAttribute('aria-label', `More options for ${presentation.group.topic}`);
        menuToggle.setAttribute('aria-haspopup', 'menu');
        menuToggle.setAttribute('aria-expanded', 'false');
        const menuDots = document.createElement('span');
        menuDots.className = 'solved-topic-menu-dots';
        menuDots.setAttribute('aria-hidden', 'true');
        menuDots.append(...Array.from({ length: 3 }, () => document.createElement('span')));
        menuToggle.appendChild(menuDots);

        const menuList = document.createElement('div');
        menuList.className = 'solved-topic-menu-list';
        menuList.setAttribute('role', 'menu');
        menuList.hidden = true;
        const removeSolved = document.createElement('button');
        removeSolved.type = 'button';
        removeSolved.className = 'solved-topic-menu-item';
        removeSolved.setAttribute('role', 'menuitem');
        removeSolved.textContent = 'Remove from Solved';
        const replaySuccess = document.createElement('button');
        replaySuccess.type = 'button';
        replaySuccess.className = 'solved-topic-menu-item';
        replaySuccess.setAttribute('role', 'menuitem');
        replaySuccess.textContent = 'Replay Success';
        menuList.append(removeSolved, replaySuccess);
        menu.append(menuToggle, menuList);
        headingRow.append(heading, menu);

        menuToggle.addEventListener('click', (event) => {
            event.stopPropagation();
            const willOpen = menuList.hidden;
            closeSolvedMenus(menuList);
            menuList.hidden = !willOpen;
            menuToggle.setAttribute('aria-expanded', String(willOpen));
            if (willOpen) removeSolved.focus();
        });

        removeSolved.addEventListener('click', () => {
            setGroupSolved(presentation.group.id, false);
            if (presentation.group.multiStep) resetQuestProgress(presentation.group.id);
            renderPresentation();
            window.requestAnimationFrame(() => {
                const activeHeading = document.getElementById(`active-topic-heading-${presentation.group.id}`);
                const nextMenu = solvedTopics.querySelector('.solved-topic-menu-toggle');
                const focusTarget = activeHeading || nextMenu || waiting.querySelector('h1');
                if (!focusTarget) return;
                if (!focusTarget.matches('button, a, input, select, textarea, [tabindex]')) focusTarget.tabIndex = -1;
                focusTarget.focus({ preventScroll: true });
            });
        });

        replaySuccess.addEventListener('click', () => {
            closeSolvedMenus();
            celebrateCompletion(presentation.group.id);
        });

        const solvedGrid = document.createElement('div');
        solvedGrid.className = 'tablet-grid';
        const cards = presentation.tablets.map((tablet) => createTablet(tablet, revealed.has(tablet.id)));
        solvedGrid.replaceChildren(...cards);
        section.append(headingRow, solvedGrid);
        return { section, solvedGrid, cards };
    }

    function renderPresentation() {
        stopLayouts();
        hidePresentationViews();
        activeTopics.replaceChildren();
        solvedTopics.replaceChildren();
        const revealed = loadRevealedTabletIds();
        const solvedIds = loadSolvedGroupIds();
        const layouts = [];
        const visiblePresentations = currentPresentations.filter((presentation) => presentation.group);
        const unsolvedPresentations = mode === 'preview'
            ? visiblePresentations
            : visiblePresentations.filter((presentation) => !solvedIds.has(presentation.group.id));

        if (mode === 'active' && unsolvedPresentations.length === 0) {
            waiting.classList.remove('hidden');
            document.title = 'Hamis Waits · Riddle Tablets';
        } else if (unsolvedPresentations.length > 0) {
            const rendered = unsolvedPresentations.map((presentation) => createTopicSection(
                presentation,
                revealed,
                { allowCompletion: mode !== 'preview' }
            ));
            activeTopics.replaceChildren(...rendered.map(({ section }) => section));
            activeTopics.classList.remove('hidden');
            activeTopics.classList.toggle('multiple-active-topics', rendered.length > 1);
            rendered.forEach(({ topicGrid, cards }) => {
                if (cards.length) layouts.push(installMasonry(topicGrid, cards));
            });
            document.title = mode === 'active' && unsolvedPresentations.length > 1
                ? 'Riddle Tablets'
                : `${displayTopic(unsolvedPresentations[0].group)} · Riddle Tablets`;
        } else if (visiblePresentations.length > 0) {
            document.title = `${displayTopic(visiblePresentations[0].group)} · Riddle Tablets`;
        }

        if (mode !== 'preview') {
            const byId = new Map(availablePresentations
                .filter((presentation) => presentation.group)
                .map((presentation) => [presentation.group.id, presentation]));
            currentPresentations.forEach((presentation) => {
                if (presentation.group) byId.set(presentation.group.id, presentation);
            });
            const solved = [...byId.values()].filter((presentation) => solvedIds.has(presentation.group.id));
            const rendered = solved.map((presentation) => createSolvedSection(presentation, revealed));
            solvedTopics.replaceChildren(...rendered.map(({ section }) => section));
            solvedTopics.classList.toggle('hidden', rendered.length === 0);
            rendered.forEach(({ solvedGrid, cards }) => {
                if (cards.length) layouts.push(installMasonry(solvedGrid, cards));
            });
        }

        if (mode === 'active') {
            const hasTopicHeadings = Boolean(document.querySelector('#active-topics .topic-heading, #solved-topics .topic-heading'));
            mainRiddleNameControl.classList.toggle('hidden', !hasTopicHeadings);
            applyMainRiddleNamePreference();
        }

        stopLayouts = () => layouts.forEach((stop) => stop());
        if (!waiting.classList.contains('hidden')) startLonglegCycle();
    }

    async function renderArchive() {
        hidePresentationViews();
        archiveView.classList.remove('hidden');
        try {
            const presentations = await listArchivePresentations();
            if (!presentations.length) {
                const empty = document.createElement('p');
                empty.className = 'topic-archive-empty';
                empty.textContent = 'No riddles have been approved yet.';
                archiveList.replaceChildren(empty);
                return;
            }
            const layouts = [];
            const rendered = presentations.map((presentation) => {
                const section = document.createElement('section');
                section.className = 'topic-section archive-topic';
                section.dataset.groupId = presentation.group.id;

                const heading = document.createElement('h2');
                heading.className = 'topic-heading archive-topic-name';
                heading.dataset.topicName = displayTopic(presentation.group);
                heading.id = `archive-topic-heading-${presentation.group.id}`;
                section.setAttribute('aria-labelledby', heading.id);

                const grid = document.createElement('div');
                grid.className = 'tablet-grid';
                const cards = presentation.tablets.map((tablet) => createTablet(tablet, false, {
                    persistRevealState: false
                }));
                grid.replaceChildren(...cards);
                section.append(heading, grid);
                return { section, heading, grid, cards };
            });

            const setNamesHidden = (hidden, animate = false) => {
                rendered.forEach(({ heading }) => {
                    renderTopicHeadingName(heading, hidden, animate && !hidden);
                });
            };

            archiveList.replaceChildren(...rendered.map(({ section }) => section));
            setNamesHidden(hideRiddleNames.checked);
            hideRiddleNames.addEventListener('change', () => {
                setNamesHidden(hideRiddleNames.checked, !hideRiddleNames.checked);
            }, { once: false });
            rendered.forEach(({ grid, cards }) => {
                if (cards.length) layouts.push(installMasonry(grid, cards));
            });
            stopLayouts = () => layouts.forEach((stop) => stop());
            document.title = 'Riddle Archive';
        } catch {
            archiveList.textContent = 'The archive could not be reached.';
        }
    }

    function signature(presentations, available = availablePresentations) {
        const summarize = (presentation) => ({
            group: presentation.group && [
                presentation.group.id,
                presentation.group.updatedAt,
                presentation.group.status,
                Boolean(presentation.group.multiStep),
                Math.max(0, Math.trunc(Number(presentation.group.questRevision) || 0))
            ],
            tablets: (presentation.tablets || []).map((tablet) => [tablet.id, tablet.updatedAt, tablet.position])
        });
        return JSON.stringify({
            current: presentations.map(summarize),
            available: available.map(summarize)
        });
    }

    async function loadPresentation({ quiet = false } = {}) {
        const loadVersion = ++presentationLoadVersion;
        try {
            let nextCurrentPresentations;
            let nextAvailablePresentations = [];
            if (mode === 'active') {
                nextAvailablePresentations = await listPresentations();
                nextCurrentPresentations = nextAvailablePresentations
                    .filter((presentation) => presentation.group && presentation.group.status === 'active');
            } else {
                const result = mode === 'preview'
                    ? await getPreviewPresentation(routeId)
                    : await getTopicPresentation(routeId);
                nextCurrentPresentations = [{
                    group: result.group || null,
                    tablets: Array.isArray(result.tablets) ? result.tablets : []
                }];
            }
            if (loadVersion !== presentationLoadVersion) return;
            const nextSignature = signature(nextCurrentPresentations, nextAvailablePresentations);
            if (quiet && nextSignature === currentSignature) return;
            availablePresentations = nextAvailablePresentations;
            currentSignature = nextSignature;
            currentPresentations = nextCurrentPresentations;
            renderPresentation();
        } catch {
            if (loadVersion !== presentationLoadVersion) return;
            if (quiet) return;
            hidePresentationViews();
            errorState.classList.remove('hidden');
        }
    }

    if (mode === 'archive') renderArchive();
    else {
        loadPresentation();
        if (mode === 'active') {
            window.setInterval(() => loadPresentation({ quiet: true }), 10000);
        }
    }

    hideMainRiddleNames.addEventListener('change', () => {
        setMainRiddleNamesHidden(hideMainRiddleNames.checked);
        applyMainRiddleNamePreference(true);
    });

    window.addEventListener('storage', (event) => {
        if (event.key === MAIN_RIDDLE_NAMES_HIDDEN_STORAGE_KEY && mode === 'active') {
            hideMainRiddleNames.checked = loadMainRiddleNamesHidden();
            applyMainRiddleNamePreference();
            return;
        }
        if ([SOLVED_GROUP_STORAGE_KEY, QUEST_PROGRESS_STORAGE_KEY].includes(event.key)
            && mode !== 'preview' && currentPresentations.length) {
            renderPresentation();
        }
    });
});
