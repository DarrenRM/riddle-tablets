document.addEventListener('DOMContentLoaded', () => {
    const groupList = document.getElementById('group-list');
    const groupListEmpty = document.getElementById('group-list-empty');
    const workspaceShell = document.getElementById('group-workspace-shell');
    const workspaceEmpty = document.getElementById('group-empty');
    const topicInput = document.getElementById('group-topic-input');
    const multiStepInput = document.getElementById('group-multi-step');
    const saveSettingsButton = document.getElementById('save-group-topic');
    const submissionLink = document.getElementById('group-submission-link');
    const toggleSubmissions = document.getElementById('toggle-group-submissions');
    const activateButton = document.getElementById('activate-group');
    const activeGroupCount = document.getElementById('active-group-count');
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
    const newGroupMultiStep = document.getElementById('new-group-multi-step');
    const createdTopic = document.getElementById('created-group-topic');
    const createdLink = document.getElementById('created-group-link');
    const deleteButton = document.getElementById('delete-group');
    const deleteDialog = document.getElementById('delete-group-dialog');
    const deleteForm = document.getElementById('delete-group-form');
    const deleteTopic = document.getElementById('delete-group-topic');
    const deleteWarning = document.getElementById('delete-group-warning');
    const deleteCounts = document.getElementById('delete-group-counts');
    const deleteConfirmation = document.getElementById('delete-group-confirmation');
    const deleteError = document.getElementById('delete-group-error');
    const confirmDelete = document.getElementById('confirm-delete-group');

    let groups = [];
    let selectedGroupId = null;
    let queue = { pending: [], approved: [], rejected: [] };
    let activeQueue = 'pending';
    let toastTimer = 0;
    let settingsSaveInFlight = false;

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
        const originalLabel = button.getAttribute('aria-label') || 'Copy link';
        button.setAttribute('aria-label', 'Copied');
        button.title = 'Copied';
        button.classList.add('copied');
        showToast('Submission link copied.');
        window.setTimeout(() => {
            button.setAttribute('aria-label', originalLabel);
            button.title = originalLabel;
            button.classList.remove('copied');
        }, 1500);
    }

    function selectedGroup() {
        return groups.find((group) => group.id === selectedGroupId) || null;
    }

    function renderGroupList() {
        const activeCount = groups.filter((group) => group.status === 'active' && !group.completedAt).length;
        activeGroupCount.textContent = `${activeCount} active`;
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
            const badges = document.createElement('span');
            badges.className = 'group-list-badges';
            if (group.status === 'active') {
                const badge = document.createElement('span');
                badge.className = 'group-mini-status status-active';
                badge.textContent = 'Active';
                badges.append(badge);
            }
            if (group.completedAt) {
                const badge = document.createElement('span');
                badge.className = 'group-mini-status status-done';
                badge.textContent = 'Done';
                badges.append(badge);
            }
            if (badges.childElementCount) header.append(badges);

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
            workspaceShell.classList.add('hidden');
            workspaceEmpty.classList.remove('hidden');
            return;
        }
        workspaceShell.classList.remove('hidden');
        workspaceEmpty.classList.add('hidden');
        topicInput.value = group.topic;
        topicInput.disabled = settingsSaveInFlight;
        multiStepInput.checked = Boolean(group.multiStep);
        multiStepInput.disabled = settingsSaveInFlight || group.status === 'active';
        multiStepInput.closest('.group-setting-toggle').title = group.status === 'active'
            ? 'Deactivate this topic before changing Multi-step Quest.'
            : (settingsSaveInFlight ? 'Saving Multi-step Quest…' : '');
        saveSettingsButton.disabled = settingsSaveInFlight;

        const url = submissionUrl(group);
        submissionLink.textContent = url;
        submissionLink.title = url;
        toggleSubmissions.textContent = group.status === 'open' ? 'Close submissions' : 'Reopen submissions';
        toggleSubmissions.disabled = settingsSaveInFlight || group.status === 'active' || Boolean(group.completedAt);
        activateButton.disabled = settingsSaveInFlight
            || Boolean(group.completedAt)
            || (group.status !== 'active' && group.counts.approved === 0);
        activateButton.textContent = group.completedAt
            ? 'Mark incomplete first'
            : (group.status === 'active' ? 'Deactivate' : 'Make active');
        toggleCompletion.textContent = group.completedAt ? 'Mark incomplete' : 'Mark complete';
        toggleCompletion.disabled = settingsSaveInFlight;
        deleteButton.disabled = settingsSaveInFlight;
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
            ? `${selectedGroup() && selectedGroup().multiStep ? 'Step' : 'Clue'} ${index + 1}`
            : (timestamp ? `Submitted ${new Date(timestamp).toLocaleString()}` : '');

        const actions = document.createElement('div');
        actions.className = 'moderation-actions';
        const group = selectedGroup();
        const questStructureLocked = Boolean(group && group.multiStep && group.status === 'active');
        const lockQuestStructureButton = (button) => {
            if (!questStructureLocked) return button;
            button.disabled = true;
            button.title = 'Deactivate this multi-step quest before changing its steps.';
            return button;
        };
        if (queueStatus === 'pending') {
            actions.append(
                lockQuestStructureButton(actionButton('Approve', 'approve-button', () => perform(row, `/api/moderation/submissions/${record.id}/approve`, 'POST', 'Clue approved.'))),
                actionButton('Save edit', 'save-edit-button', () => perform(row, `/api/moderation/submissions/${record.id}`, 'PUT', 'Pending edit saved.')),
                actionButton('Reject', 'reject-button', () => perform(row, `/api/moderation/submissions/${record.id}/reject`, 'POST', 'Clue rejected.'))
            );
        } else if (queueStatus === 'approved') {
            const itemName = selectedGroup() && selectedGroup().multiStep ? 'step' : 'clue';
            const up = actionButton(`Move ${itemName} up`, 'quiet-button', () => moveApproved(record.id, -1));
            const down = actionButton(`Move ${itemName} down`, 'quiet-button', () => moveApproved(record.id, 1));
            up.disabled = questStructureLocked || index === 0;
            down.disabled = questStructureLocked || index === queue.approved.length - 1;
            if (questStructureLocked) {
                up.title = 'Deactivate this multi-step quest before reordering its steps.';
                down.title = up.title;
            }
            const unapprove = lockQuestStructureButton(actionButton('Unapprove', 'reject-button', () => perform(row, `/api/moderation/tablets/${record.id}/unpublish`, 'POST', 'Clue returned to rejected.')));
            actions.append(
                up,
                down,
                actionButton('Save changes', 'approve-button', () => perform(row, `/api/moderation/tablets/${record.id}`, 'PUT', 'Approved clue updated.')),
                unapprove
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
                body: JSON.stringify({ topic: newTopic.value, multiStep: newGroupMultiStep.checked })
            });
            selectedGroupId = result.group.id;
            const url = submissionUrl(result.group);
            createdTopic.textContent = result.group.topic;
            createdLink.textContent = url;
            createdLink.title = url;
            createForm.classList.add('hidden');
            createSuccess.classList.remove('hidden');
            await refreshAll();
        } catch (error) {
            createError.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('copy-created-group-link').addEventListener('click', (event) => copyText(createdLink.textContent, event.currentTarget));
    document.getElementById('copy-group-link').addEventListener('click', (event) => copyText(submissionLink.textContent, event.currentTarget));

    multiStepInput.addEventListener('change', async () => {
        const group = selectedGroup();
        if (!group || group.status === 'active' || settingsSaveInFlight) {
            if (group) multiStepInput.checked = Boolean(group.multiStep);
            return;
        }

        const groupId = group.id;
        const previousValue = Boolean(group.multiStep);
        const nextValue = multiStepInput.checked;
        const pendingTopicValue = topicInput.value;
        group.multiStep = nextValue;
        settingsSaveInFlight = true;
        renderGroupHeader();
        topicInput.value = pendingTopicValue;
        let saveError = '';
        try {
            const result = await request(`/api/moderation/groups/${groupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: group.topic, multiStep: nextValue })
            });
            Object.assign(group, result.group);
            showToast(`Multi-step Quest ${nextValue ? 'enabled' : 'disabled'}.`);
        } catch (error) {
            group.multiStep = previousValue;
            saveError = error.message;
        } finally {
            settingsSaveInFlight = false;
            await refreshAll();
            if (selectedGroupId === groupId) topicInput.value = pendingTopicValue;
            if (saveError) status.textContent = saveError;
        }
    });

    saveSettingsButton.addEventListener('click', async () => {
        if (settingsSaveInFlight) return;
        try {
            await request(`/api/moderation/groups/${selectedGroupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: topicInput.value, multiStep: multiStepInput.checked })
            });
            showToast('Riddle settings updated.');
            await refreshAll();
        } catch (error) {
            status.textContent = error.message;
        }
    });

    toggleSubmissions.addEventListener('click', () => {
        const group = selectedGroup();
        changeStatus(group.status === 'open' ? 'close' : 'open', null, group.status === 'open' ? 'Submissions closed.' : 'Submissions reopened.');
    });
    activateButton.addEventListener('click', () => {
        if (settingsSaveInFlight) return;
        const group = selectedGroup();
        if (!group) return;
        if (group.status === 'active') {
            changeStatus(
                'deactivate',
                'Remove this topic from the live page? Its clues will remain ready to reactivate.',
                'Topic removed from the live page.'
            );
            return;
        }
        const activeCount = groups.filter((candidate) => candidate.status === 'active' && !candidate.completedAt).length;
        const alongside = activeCount === 0
            ? 'It will be the only active topic.'
            : `It will appear alongside ${activeCount} active topic${activeCount === 1 ? '' : 's'}.`;
        changeStatus(
            'activate',
            `Add this topic to the live page? ${alongside}`,
            'Topic added to the live page.'
        );
    });
    toggleCompletion.addEventListener('click', () => {
        const group = selectedGroup();
        if (!group) return;
        const completed = !group.completedAt;
        changeStatus(completed ? 'complete' : 'incomplete', null, completed ? 'Topic marked complete.' : 'Topic marked incomplete.');
    });

    function openDeleteDialog() {
        const group = selectedGroup();
        if (!group) return;

        const isActive = group.status === 'active' && !group.completedAt;
        deleteDialog.dataset.groupId = group.id;
        deleteDialog.dataset.topic = group.topic;
        deleteTopic.textContent = `“${group.topic}”`;
        deleteCounts.replaceChildren(...[
            `${group.counts.approved} approved clue${group.counts.approved === 1 ? '' : 's'}`,
            `${group.counts.pending} pending clue${group.counts.pending === 1 ? '' : 's'}`,
            `${group.counts.rejected} rejected clue${group.counts.rejected === 1 ? '' : 's'}`
        ].map((label) => {
            const item = document.createElement('li');
            item.textContent = label;
            return item;
        }));
        deleteWarning.textContent = isActive
            ? 'This topic is currently live. Deactivate it before it can be deleted.'
            : 'You are about to permanently delete this topic and every clue attached to it.';
        deleteConfirmation.value = '';
        deleteConfirmation.disabled = isActive;
        deleteError.textContent = isActive ? 'Deletion is blocked while a topic is active.' : '';
        confirmDelete.disabled = true;
        deleteDialog.showModal();
        (isActive ? document.getElementById('cancel-delete-group') : deleteConfirmation).focus();
    }

    function closeDeleteDialog() {
        deleteDialog.close();
    }

    deleteButton.addEventListener('click', openDeleteDialog);
    document.getElementById('close-delete-group-dialog').addEventListener('click', closeDeleteDialog);
    document.getElementById('cancel-delete-group').addEventListener('click', closeDeleteDialog);
    deleteConfirmation.addEventListener('input', () => {
        confirmDelete.disabled = deleteConfirmation.disabled || deleteConfirmation.value !== 'DELETE';
    });
    deleteForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (deleteConfirmation.value !== 'DELETE') return;

        const groupId = deleteDialog.dataset.groupId;
        const topic = deleteDialog.dataset.topic;
        confirmDelete.disabled = true;
        deleteConfirmation.disabled = true;
        deleteError.textContent = '';
        try {
            await request(`/api/moderation/groups/${groupId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmation: 'DELETE', topic })
            });
            closeDeleteDialog();
            selectedGroupId = null;
            showToast('Topic permanently deleted.');
            await refreshAll();
        } catch (error) {
            deleteError.textContent = error.message;
            deleteConfirmation.disabled = false;
            confirmDelete.disabled = deleteConfirmation.value !== 'DELETE';
        }
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
