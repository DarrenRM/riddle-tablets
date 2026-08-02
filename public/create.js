import { listTablets, saveTablet } from './tablet-api.js';
import { clearLegacyTablets, loadLegacyTablets } from './tablet-store.js';

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('tablet-form');
    const idInput = document.getElementById('tablet-id');
    const topicInput = document.getElementById('topic-input');
    const authorInput = document.getElementById('author-input');
    const riddleInput = document.getElementById('riddle-input');
    const saveButton = document.getElementById('save-tablet-btn');
    const cancelButton = document.getElementById('cancel-edit-btn');
    const status = document.getElementById('form-status');
    const toast = document.getElementById('save-toast');
    const savedTablets = document.getElementById('saved-tablets');
    const savedEmpty = document.getElementById('saved-empty');
    let tablets = [];
    let toastTimer = null;

    function showSuccess(message) {
        window.clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add('visible');
        toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2600);
    }

    function resetForm() {
        form.reset();
        idInput.value = '';
        saveButton.textContent = 'Save Tablet';
        cancelButton.classList.add('hidden');
    }

    function beginEdit(tablet) {
        idInput.value = tablet.id;
        topicInput.value = tablet.topic;
        authorInput.value = tablet.author;
        riddleInput.value = tablet.riddle;
        saveButton.textContent = 'Save Changes';
        cancelButton.classList.remove('hidden');
        status.textContent = `Editing “${tablet.topic}”.`;
        topicInput.focus();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderSaved() {
        savedTablets.replaceChildren();
        savedEmpty.classList.toggle('hidden', tablets.length > 0);
        tablets.forEach((tablet) => {
            const row = document.createElement('article');
            row.className = 'saved-tablet-row';
            const details = document.createElement('div');
            details.className = 'saved-tablet-details';
            const topic = document.createElement('h3');
            topic.textContent = tablet.topic;
            const author = document.createElement('p');
            author.textContent = `by ${tablet.author}`;
            const preview = document.createElement('p');
            preview.className = 'saved-tablet-preview';
            preview.textContent = tablet.riddle;
            details.append(topic, author, preview);
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'row-edit-button';
            edit.textContent = 'Edit';
            edit.addEventListener('click', () => beginEdit(tablet));
            row.append(details, edit);
            savedTablets.appendChild(row);
        });
    }

    async function refresh() {
        tablets = await listTablets();
        renderSaved();
    }

    async function migrateLegacy() {
        const legacy = loadLegacyTablets();
        if (legacy.length === 0) return;
        const known = new Set(tablets.map((tablet) => tablet.id));
        let imported = 0;
        for (const tablet of legacy) {
            if (known.has(tablet.id)) continue;
            await saveTablet(tablet);
            imported += 1;
        }
        clearLegacyTablets();
        if (imported) showSuccess(`Imported ${imported} browser tablet${imported === 1 ? '' : 's'}.`);
        await refresh();
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        saveButton.disabled = true;
        status.textContent = '';
        try {
            const wasEditing = Boolean(idInput.value);
            const tablet = await saveTablet({
                id: idInput.value || undefined,
                topic: topicInput.value,
                author: authorInput.value,
                riddle: riddleInput.value
            });
            resetForm();
            await refresh();
            showSuccess(wasEditing ? `Saved changes to “${tablet.topic}”.` : `Saved “${tablet.topic}”.`);
        } catch (error) {
            if (error.status === 401) window.location.replace('/create');
            else status.textContent = error.message;
        } finally {
            saveButton.disabled = false;
        }
    });

    cancelButton.addEventListener('click', () => {
        resetForm();
        status.textContent = 'Edit cancelled.';
    });

    (async () => {
        try {
            await refresh();
            await migrateLegacy();
        } catch (error) {
            if (error.status === 401) window.location.replace('/create');
            else status.textContent = error.message;
        }
    })();
});
