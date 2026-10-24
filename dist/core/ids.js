// IDs: `<prefix>_<ULID>`. A ULID is 10 characters of millisecond time and 16 of randomness, Crockford base32.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_RE = /^(dec|fnd|ent|rul|tsk|epi|not|edg|evt)_[0-9A-HJKMNP-TV-Z]{26}$/;
export function isValidId(id) {
    return ID_RE.test(id);
}
/** `random` returns 16 values in 0 to 31; the host supplies it (crypto where available). */
export function newId(prefix, timeMs, random) {
    let time = '';
    let t = Math.floor(timeMs);
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[t % 32] + time;
        t = Math.floor(t / 32);
    }
    const rand = random()
        .slice(0, 16)
        .map(n => CROCKFORD[n & 31])
        .join('');
    return `${prefix}_${time}${rand.padEnd(16, '0')}`;
}
/** 16 random base32 digits from the platform's crypto source. */
export function cryptoRandom() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(b => b & 31);
}
/** Repeatable "random" digits from a seed (fixtures and tests only; never for real data). */
export function seededRandom(seed) {
    // FNV-1a seed, then xorshift32 carried across calls, so ids made in one batch never repeat.
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++)
        h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    if (h === 0)
        h = 1;
    return () => {
        const out = [];
        for (let i = 0; i < 16; i++) {
            h ^= h << 13;
            h >>>= 0;
            h ^= h >>> 17;
            h ^= h << 5;
            h >>>= 0;
            out.push(h & 31);
        }
        return out;
    };
}
