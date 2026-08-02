async function request(url, options) {
    const response = await fetch(url, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(result.message || 'The archive could not be reached.');
        error.status = response.status;
        throw error;
    }
    return result;
}

export async function listTablets() {
    const result = await request('/api/tablets');
    return Array.isArray(result.tablets) ? result.tablets : [];
}

export async function saveTablet(tablet) {
    const id = tablet && tablet.id;
    const result = await request(id ? `/api/tablets/${encodeURIComponent(id)}` : '/api/tablets', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tablet)
    });
    return result.tablet;
}
