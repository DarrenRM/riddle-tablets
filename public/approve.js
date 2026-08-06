document.addEventListener('DOMContentLoaded', () => {
    const groupList = document.getElementById('group-list');
    const groupListEmpty = document.getElementById('group-list-empty');
    const workspace = document.getElementById('group-workspace');
    const workspaceEmpty = document.getElementById('group-empty');
    const topicInput = document.getElementById('group-topic-input');
    const submissionLink = document.getElementById('group-submission-link');
    const toggleSubmissions = document.getElementById('toggle-group-submissions');
    const activateButton = document.getElementById('activate-group');
    const toggleCompletion = document.getElementById('toggle-group-completion');
    const tabs = document.getElementById('moderation-tabs');
    const list = document.getElementById('moderation-list');
    const status = document.getElementById('moderation-status');
    const toast = document.getElementById('moderation-toast');
    const legacyBanner = document.getElementById('legacy-banner');
    const legacySummary = document.getElementById('legacy-summary');
    const dialog = document.getElementById('create-group-dialog');
    const createForm = document.getElementById('create-group-form');
    const createSuccess = document.getElementById('create-group-success');
    const createError = document.getElementById('create-group-error');
    const newTopic = document.getElementById('new-group-topic');
    const createdTopic = document.getElementById('created-group-topic');
    const createdLink = document.getElementById('created-group-link');

    let groups = [];
    let selectedGroupId = null;
    let queue = { pending: [], approved: [], rejected: [] };
    let activeQueue = 'pending';
    let toastTimer = 0;

    async function request(url, options = {}) {
        const response = await fetch(url, options);
        const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result.message || 'The moderation action failed.');
            error.status = response.status;
            throw error;
        }
        return result;
    }

    function showToast(message) {
        window.clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add('visible');
        toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2600);
    }

    function submissionUrl(group) {
        return `${window.location.origin}/submit/${group.submissionToken}`;
    }

    async function copyText(value, button) {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            const helper = document.createElement('textarea');
            helper.value = value;
            helper.style.position = 'fixed';
            helper.style.opacity = '0';
            document.body.appendChild(helper);
            helper.select();
            document.execCommand('copy');
            helper.remove();
        }
        const original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(() => { button.textContent = original; }, 1500);
    }

    function selectedGroup() {
        return groups.find((group) => group.id === selectedGroupId) || null;
    }

    function renderGroupList() {
        groupList.replaceChildren(...groups.map((group) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `group-list-item group-list-item-${group.status}`;
            button.classList.toggle('selected', group.id === selectedGroupId);
            button.addEventListener('click', () => selectGroup(group.id));

            const header = document.createElement('span');
            header.className = 'group-list-item-header';
            const topic = document.createElement('strong');
            topic.textContent = group.topic;
            header.append(topic);
            if (group.status === 'active') {
                const badge = document.createElement('span');
                badge.className = 'group-mini-status status-active';
                badge.textContent = 'Active';
                header.append(badge);
            }
            if (group.completedAt) {
                const badge = document.createElement('span');
                badge.className = 'group-mini-status status-done';
                badge.textContent = 'Done';
                header.append(badge);
            }

            const counts = document.createElement('span');
            counts.className = 'group-list-counts';
            counts.textContent = `${group.counts.pending} pending · ${group.counts.approved} approved`;
            button.append(header, counts);
            return button;
        }));
        groupListEmpty.classList.toggle('hidden', groups.length > 0);
    }

    function renderGroupHeader() {
        const group = selectedGroup();
        if (!group) {
            workspace.classList.add('hidden');
            workspaceEmpty.classList.remove('hidden');
            return;
        }
        workspace.classList.remove('hidden');
        workspaceEmpty.classList.add('hidden');
        topicInput.value = group.topic;

        const url = submissionUrl(group);
        submissionLink.value = url;
        toggleSubmissions.textContent = group.status === 'open' ? 'Close submissions' : 'Reopen submissions';
        toggleSubmissions.disabled = group.status === 'active';
        activateButton.disabled = group.status === 'active' || group.counts.approved === 0;
        activateButton.textContent = group.status === 'active' ? 'Currently active' : 'Make active';
        toggleCompletion.textContent = group.completedAt ? 'Mark incomplete' : 'Mark complete';
    }

    function fieldsFrom(row) {
        return {
            author: row.querySelector('[name="author"]').value,
            riddle: row.querySelector('[name="riddle"]').value
        };
    }

    async function perform(row, url, method, successMessage) {
        const buttons = [...row.querySelectorAll('button')];
        buttons.forEach((button) => { button.disabled = true; });
        try {
            await request(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: method === 'DELETE' ? undefined : JSON.stringify(fieldsFrom(row))
            });
            showToast(successMessage);
            await refreshAll();
        } catch (error) {
            if (error.status === 401) window.location.replace('/approve');
            else {
                status.textContent = error.message;
                buttons.forEach((button) => { button.disabled = false; });
            }
        }
    }

    function actionButton(label, className, handler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }

    async function moveApproved(id, direction) {
        const ids = queue.approved.map((record) => record.id);
        const index = ids.indexOf(id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        await request(`/api/moderation/groups/${selectedGroupId}/tablet-order`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        showToast('Clue order updated.');
        await refreshAll();
    }

    function createRow(record, queueStatus, index) {
        const row = document.createElement('article');
        row.className = `moderation-row moderation-${queueStatus}`;
        row.dataset.id = record.id;

        const fields = document.createElement('div');
        fields.className = 'moderation-fields';
        [
            ['Author', 'author', 'input', 120],
            ['Clue', 'riddle', 'textarea', 2000]
        ].forEach(([labelText, name, kind, maxLength]) => {
            const field = document.createElement('label');
            field.className = `moderation-field moderation-field-${name}`;
            const label = document.createElement('span');
            label.textContent = labelText;
            const control = document.createElement(kind);
            control.name = name;
            control.maxLength = maxLength;
            control.required = true;
            control.value = record[name];
            if (kind === 'textarea') control.rows = 5;
            field.append(label, control);
            fields.appendChild(field);
        });

        const meta = document.createElement('p');
        meta.className = 'moderation-meta';
        const timestamp = record.submittedAt || record.createdAt || record.updatedAt;
        meta.textContent = queueStatus === 'approved'
            ? `Clue ${index + 1}`
            : (timestamp ? `Submitted ${new Date(timestamp).toLocaleString()}` : '');

        const actions = document.createElement('div');
        actions.className = 'moderation-actions';
        if (queueStatus === 'pending') {
            actions.append(
                actionButton('Approve', 'approve-button', () => perform(row, `/api/moderation/submissions/${record.id}/approve`, 'POST', 'Clue approved.')),
                actionButton('Save edit', 'save-edit-button', () => perform(row, `/api/moderation/submissions/${record.id}`, 'PUT', 'Pending edit saved.')),
                actionButton('Reject', 'reject-button', () => perform(row, `/api/moderation/submissions/${record.id}/reject`, 'POST', 'Clue rejected.'))
            );
        } else if (queueStatus === 'approved') {
            const up = actionButton('Move up', 'quiet-button', () => moveApproved(record.id, -1));
            const down = actionButton('Move down', 'quiet-button', () => moveApproved(record.id, 1));
            up.disabled = index === 0;
            down.disabled = index === queue.approved.length - 1;
            actions.append(
                up,
                down,
                actionButton('Save changes', 'approve-button', () => perform(row, `/api/moderation/tablets/${record.id}`, 'PUT', 'Approved clue updated.')),
                actionButton('Unapprove', 'reject-button', () => perform(row, `/api/moderation/tablets/${record.id}/unpublish`, 'POST', 'Clue returned to rejected.'))
            );
        } else {
            actions.append(
                actionButton('Restore to pending', 'approve-button', () => perform(row, `/api/moderation/submissions/${record.id}/restore`, 'POST', 'Clue restored.')),
                actionButton('Save edit', 'save-edit-button', () => perform(row, `/api/moderation/submissions/${record.id}`, 'PUT', 'Rejected edit saved.')),
                actionButton('Delete permanently', 'delete-button', () => {
                    if (window.confirm('Permanently delete this rejected clue?')) {
                        perform(row, `/api/moderation/submissions/${record.id}`, 'DELETE', 'Rejected clue deleted.');
                    }
                })
            );
        }
        row.append(fields, meta, actions);
        return row;
    }

    function renderQueue() {
        tabs.querySelectorAll('[data-status]').forEach((button) => {
            button.classList.toggle('active', button.dataset.status === activeQueue);
        });
        Object.keys(queue).forEach((key) => {
            const count = tabs.querySelector(`[data-count="${key}"]`);
            if (count) count.textContent = String(queue[key].length);
        });
        const records = queue[activeQueue];
        list.replaceChildren(...records.map((record, index) => createRow(record, activeQueue, index)));
        status.textContent = records.length
            ? `${records.length} ${activeQueue} clue${records.length === 1 ? '' : 's'}.`
            : `No ${activeQueue} clues.`;
    }

    async function loadQueue() {
        if (!selectedGroupId) {
            queue = { pending: [], approved: [], rejected: [] };
            return;
        }
        const result = await request(`/api/moderation/groups/${selectedGroupId}/queue`);
        queue = { pending: result.pending, approved: result.approved, rejected: result.rejected };
    }

    async function loadGroups() {
        const result = await request('/api/moderation/groups');
        groups = result.groups.sort((left, right) => Boolean(left.completedAt) - Boolean(right.completedAt));
        const legacyCount = result.legacy.tablets + result.legacy.submissions;
        legacyBanner.classList.toggle('hidden', legacyCount === 0);
        legacySummary.textContent = legacyCount
            ? `${result.legacy.tablets} approved and ${result.legacy.submissions} submitted record${legacyCount === 1 ? '' : 's'} can be grouped by their existing topics.`
            : '';
        if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) selectedGroupId = null;
        if (!selectedGroupId && groups.length) selectedGroupId = groups[0].id;
    }

    async function refreshAll() {
        try {
            await loadGroups();
            await loadQueue();
            renderGroupList();
            renderGroupHeader();
            renderQueue();
        } catch (error) {
            if (error.status === 401) window.location.replace('/approve');
            else status.textContent = error.message;
        }
    }

    async function selectGroup(id) {
        selectedGroupId = id;
        activeQueue = 'pending';
        await refreshAll();
    }

    async function changeStatus(action, confirmation, successMessage) {
        if (confirmation && !window.confirm(confirmation)) return;
        try {
            await request(`/api/moderation/groups/${selectedGroupId}/${action}`, { method: 'POST' });
            showToast(successMessage);
            await refreshAll();
        } catch (error) {
            status.textContent = error.message;
        }
    }

    document.getElementById('new-group-button').addEventListener('click', () => {
        createForm.classList.remove('hidden');
        createSuccess.classList.add('hidden');
        createForm.reset();
        createError.textContent = '';
        dialog.showModal();
        newTopic.focus();
    });
    document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => dialog.close()));
    document.getElementById('close-group-dialog').addEventListener('click', () => dialog.close());

    createForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = document.getElementById('create-group-submit');
        submit.disabled = true;
        createError.textContent = '';
        try {
            const result = await request('/api/moderation/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: newTopic.value })
            });
            selectedGroupId = result.group.id;
            const url = submissionUrl(result.group);
            createdTopic.textContent = result.group.topic;
            createdLink.value = url;
            createForm.classList.add('hidden');
            createSuccess.classList.remove('hidden');
            await refreshAll();
        } catch (error) {
            createError.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('copy-created-group-link').addEventListener('click', (event) => copyText(createdLink.value, event.currentTarget));
    document.getElementById('copy-group-link').addEventListener('click', (event) => copyText(submissionLink.value, event.currentTarget));

    document.getElementById('save-group-topic').addEventListener('click', async () => {
        try {
            await request(`/api/moderation/groups/${selectedGroupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: topicInput.value })
            });
            showToast('Topic updated.');
            await refreshAll();
        } catch (error) {
            status.textContent = error.message;
        }
    });

    toggleSubmissions.addEventListener('click', () => {
        const group = selectedGroup();
        changeStatus(group.status === 'open' ? 'close' : 'open', null, group.status === 'open' ? 'Submissions closed.' : 'Submissions reopened.');
    });
    activateButton.addEventListener('click', () => changeStatus(
        'activate',
        'Make this the active topic? The current active topic will no longer be active.',
        'Topic is now active.'
    ));
    toggleCompletion.addEventListener('click', () => {
        const group = selectedGroup();
        if (!group) return;
        const completed = !group.completedAt;
        changeStatus(completed ? 'complete' : 'incomplete', null, completed ? 'Topic marked complete.' : 'Topic marked incomplete.');
    });

    document.getElementById('import-legacy-button').addEventListener('click', async () => {
        if (!window.confirm('Import existing records into groups based on their current topic fields?')) return;
        try {
            const result = await request('/api/moderation/groups/import-legacy', { method: 'POST' });
            showToast(`${result.imported} legacy record${result.imported === 1 ? '' : 's'} imported.`);
            await refreshAll();
        } catch (error) {
            status.textContent = error.message;
        }
    });

    tabs.addEventListener('click', (event) => {
        const button = event.target.closest('[data-status]');
        if (!button) return;
        activeQueue = button.dataset.status;
        renderQueue();
    });

    refreshAll();
});
