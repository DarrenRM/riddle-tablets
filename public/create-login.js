document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('create-login-form');
    const password = document.getElementById('create-password');
    const status = document.getElementById('login-status');
    const button = form.querySelector('button');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        status.textContent = '';
        try {
            const response = await fetch('/api/create/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password.value })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'The chamber remains sealed.');
            window.location.replace('/create');
        } catch (error) {
            status.textContent = error.message;
            password.select();
            button.disabled = false;
        }
    });
});
