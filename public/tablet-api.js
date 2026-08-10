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

export function getActivePresentation() {
    return request('/api/presentation');
}

export async function listPresentations() {
    const result = await request('/api/presentations');
    return Array.isArray(result.presentations) ? result.presentations : [];
}

export async function listArchivePresentations() {
    const result = await request('/api/archive');
    return Array.isArray(result.presentations) ? result.presentations : [];
}

export function getTopicPresentation(id) {
    return request(`/api/topics/${encodeURIComponent(id)}`);
}

export function getPreviewPresentation(id) {
    return request(`/api/moderation/groups/${encodeURIComponent(id)}/presentation`);
}

export async function listTopics() {
    const result = await request('/api/topics');
    return Array.isArray(result.topics) ? result.topics : [];
}

// Backward-compatible exports for stale modules and local experiments.
export async function listTablets() {
    const result = await getActivePresentation();
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
