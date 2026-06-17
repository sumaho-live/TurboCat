export function normalizeDeploymentPath(value: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
        return '';
    }

    const normalized = trimmed
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    return normalized
        .split('/')
        .filter(segment => segment && segment !== '.' && segment !== '..')
        .join('/');
}
