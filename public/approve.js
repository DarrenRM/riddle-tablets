document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.getElementById('moderation-tabs');
    const list = document.getElementById('moderation-list');
    const status = document.getElementById('moderation-status');
    const toast = document.getElementById('moderation-toast');
    let queues = { pending: [], published: [], rejected: [] };
    let activeStatus = 'pending';
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

    function fieldsFrom(row) {
        return {
            topic: row.querySelector('[name="topic"]').value,
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
            await refresh();
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

    function createRow(record, queueStatus) {
        const row = document.createElement('article');
        row.className = `moderation-row moderation-${queueStatus}`;
        row.dataset.id = record.id;

        const fields = document.createElement('div');
        fields.className = 'moderation-fields';
        const specs = [
            ['Topic', 'topic', 'input', 120],
            ['Author', 'author', 'input', 120],
            ['Riddle', 'riddle', 'textarea', 2000]
        ];
        specs.forEach(([labelText, name, kind, maxLength]) => {
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
        meta.textContent = timestamp ? `Submitted ${new Date(timestamp).toLocaleString()}` : '';

        const actions = document.createElement('div');
        actions.className = 'moderation-actions';
        if (queueStatus === 'pending') {
            actions.append(
                actionButton('Approve', 'approve-button', () => perform(row, `/api/moderation/submissions/${record.id}/approve`, 'POST', 'Inscription approved.')),
                actionButton('Save edit', 'save-edit-button', () => perform(row, `/api/moderation/submissions/${record.id}`, 'PUT', 'Pending edit saved.')),
                actionButton('Reject', 'reject-button', () => perform(row, `/api/moderation/submissions/${record.id}/reject`, 'POST', 'Inscription rejected.'))
            );
        } else if (queueStatus === 'published') {
            actions.append(
                actionButton('Save changes', 'approve-button', () => perform(row, `/api/moderation/tablets/${record.id}`, 'PUT', 'Published inscription updated.')),
                actionButton('Unpublish', 'reject-button', () => perform(row, `/api/moderation/tablets/${record.id}/unpublish`, 'POST', 'Inscription unpublished.'))
            );
        } else {
            actions.append(
                actionButton('Restore to pending', 'approve-button', () => perform(row, `/api/moderation/submissions/${record.id}/restore`, 'POST', 'Inscription restored.')),
                actionButton('Save edit', 'save-edit-button', () => perform(row, `/api/moderation/submissions/${record.id}`, 'PUT', 'Rejected edit saved.')),
                actionButton('Delete permanently', 'delete-button', () => {
                    if (window.confirm('Permanently delete this rejected inscription?')) {
                        perform(row, `/api/moderation/submissions/${record.id}`, 'DELETE', 'Rejected inscription deleted.');
                    }
                })
            );
        }
        row.append(fields, meta, actions);
        return row;
    }

    function render() {
        tabs.querySelectorAll('[data-status]').forEach((button) => {
            button.classList.toggle('active', button.dataset.status === activeStatus);
        });
        Object.keys(queues).forEach((key) => {
            const count = tabs.querySelector(`[data-count="${key}"]`);
            if (count) count.textContent = String(queues[key].length);
        });
        const records = queues[activeStatus];
        list.replaceChildren(...records.map((record) => createRow(record, activeStatus)));
        status.textContent = records.length
            ? `${records.length} ${activeStatus} inscription${records.length === 1 ? '' : 's'}.`
            : `No ${activeStatus} inscriptions.`;
    }

    async function refresh() {
        try {
            queues = await request('/api/moderation/queue');
            render();
        } catch (error) {
            if (error.status === 401) window.location.replace('/approve');
            else status.textContent = error.message;
        }
    }

    tabs.addEventListener('click', (event) => {
        const button = event.target.closest('[data-status]');
        if (!button) return;
        activeStatus = button.dataset.status;
        render();
    });

    refresh();
});
