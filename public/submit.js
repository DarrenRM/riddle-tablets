document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('submission-form');
    const button = document.getElementById('submit-tablet-btn');
    const status = document.getElementById('form-status');
    const toast = document.getElementById('submit-toast');
    const topic = document.getElementById('submission-topic');
    const unavailable = document.getElementById('submission-unavailable');
    const unavailableTitle = document.getElementById('submission-unavailable-title');
    const unavailableCopy = document.getElementById('submission-unavailable-copy');
    let toastTimer = 0;

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
        window.clearTimeout(toastTimer);
        toast.textContent = 'Submitted for review.';
        toast.classList.add('visible');
        toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
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
            form.reset();
            status.textContent = '';
            showSuccess();
            document.getElementById('author-input').focus();
        } catch (error) {
            status.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    });
});
