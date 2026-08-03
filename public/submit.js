document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('submission-form');
    const button = document.getElementById('submit-tablet-btn');
    const status = document.getElementById('form-status');
    const toast = document.getElementById('submit-toast');
    let toastTimer = 0;

    function showSuccess() {
        window.clearTimeout(toastTimer);
        toast.textContent = 'Submitted for review.';
        toast.classList.add('visible');
        toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        button.disabled = true;
        status.textContent = 'Sending inscription...';
        const data = new FormData(form);
        try {
            const response = await fetch('/api/submissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    topic: data.get('topic'),
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
            document.getElementById('topic-input').focus();
        } catch (error) {
            status.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    });
});
