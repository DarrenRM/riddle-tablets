document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('approve-login-form');
    const password = document.getElementById('approve-password');
    const status = document.getElementById('login-status');
    const button = form.querySelector('button');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        status.textContent = '';
        try {
            const response = await fetch('/api/moderation/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password.value })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.message || 'The chamber remains sealed.');
            window.location.replace('/approve');
        } catch (error) {
            status.textContent = error.message;
            password.select();
            button.disabled = false;
        }
    });
});
