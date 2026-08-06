document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('submission-form');
    const button = document.getElementById('submit-tablet-btn');
    const status = document.getElementById('form-status');
    const topic = document.getElementById('submission-topic');
    const unavailable = document.getElementById('submission-unavailable');
    const success = document.getElementById('submission-success');
    const unavailableTitle = document.getElementById('submission-unavailable-title');
    const unavailableCopy = document.getElementById('submission-unavailable-copy');

    const parts = window.location.pathname.split('/').filter(Boolean);
    const token = parts[0] === 'submit' && parts.length === 2 ? parts[1] : '';

    function showUnavailable(title, copy) {
        topic.textContent = '';
        form.classList.add('hidden');
        unavailable.classList.remove('hidden');
        unavailableTitle.textContent = title;
        unavailableCopy.textContent = copy;
    }

    function showSuccess() {
        form.classList.add('hidden');
        status.textContent = '';
        success.classList.remove('hidden');
    }

    if (!token) {
        showUnavailable('A topic link is required', 'Use the submission link posted by a moderator in the matching Discord thread.');
        return;
    }

    try {
        const response = await fetch(`/api/submission-groups/${encodeURIComponent(token)}`);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'That submission link is not available.');
        topic.textContent = result.group.topic;
        document.title = `Submit a clue: ${result.group.topic}`;
        if (!result.accepting) {
            showUnavailable('Submissions are closed', `The moderators have finished collecting clues for “${result.group.topic}.”`);
            return;
        }
        form.classList.remove('hidden');
        document.getElementById('author-input').focus();
    } catch (error) {
        showUnavailable('This link is not available', error.message);
        return;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        button.disabled = true;
        status.textContent = 'Sending inscription...';
        const data = new FormData(form);
        try {
            const response = await fetch(`/api/submission-groups/${encodeURIComponent(token)}/submissions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    author: data.get('author'),
                    riddle: data.get('riddle'),
                    website: data.get('website')
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.message || 'The inscription could not be submitted.');
            showSuccess();
        } catch (error) {
            status.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    });
});
