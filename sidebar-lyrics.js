(function SidebarLyrics() {

    // ==========================================
    // 0. CSS STYLES FOR CLEAN SIDEBAR & LYRICS
    // ==========================================
    document.getElementById('custom-sidebar-fixes-style')?.remove();
    const styleEl = document.createElement('style');
    styleEl.id = 'custom-sidebar-fixes-style';
    styleEl.textContent = `
        /* Flex layout for panel container to allow dynamic lyrics filling */
        .main-nowPlayingView-content, .main-nowPlayingView-panel {
            display: flex !important;
            flex-direction: column !important;
            height: 100% !important;
        }
        /* Gently pull up track info section & optimize spacing */
        .main-nowPlayingView-panel > div:first-child,
        .main-nowPlayingView-panel > header:first-child,
        .main-nowPlayingView-panel > .main-nowPlayingView-section:first-child {
            margin-bottom: 0px !important;
            padding-bottom: 0px !important;
        }
        /* Centering inside sidebar */
        [data-testid="now-playing-panel"] .main-nowPlayingView-panel > div {
            justify-content: center !important;
            width: 100% !important;
        }
        [data-testid="now-playing-panel"] {
            height: 100% !important;
        }
        /* Immediately hide all extra cards except queue and our custom lyrics container */
        .main-nowPlayingView-section:not(.main-nowPlayingView-queue):not(#custom-sidebar-lyrics) {
            display: none !important;
        }
        #custom-sidebar-lyrics {
            flex: 1 1 auto !important;
            height: 0 !important;
            min-height: 120px !important;
            margin-top: -4px !important;
            padding-top: 0px !important;
        }
        .sidebar-lyric-line {
            cursor: pointer;
            user-select: none;
            transform-origin: left center;
        }
        .sidebar-lyric-line:hover {
            opacity: 0.65 !important;
        }
    `;
    document.head.appendChild(styleEl);

    // ==========================================
    // 1. STATE & CACHE
    // ==========================================
    let syncInterval = null;
    let parsedLyrics = []; // [{ time: number, element: HTMLElement }]
    let lastActiveIndex = -1;
    let currentFetchController = null;
    const lyricsCache = new Map(); // uri -> { lines: [{ time, text }], source: string } | null

    // ==========================================
    // 2. STRING CLEANING & LRC PARSING UTILS
    // ==========================================
    function cleanTitle(title) {
        if (!title) return '';
        return title
            .replace(/\s*-\s*(feat|ft|with|prod)\.?\s+.*/i, '')
            .replace(/\s*(\(|\[)(feat|ft|with|prod)\.?\s+.*(\)|\])/i, '')
            .replace(/\s*-\s*.*(?:remaster|remastered|bonus track|deluxe|radio edit|clean|single version|anniversary|expanded|live).*/i, '')
            .replace(/\s*(\(|\[).*(?:remaster|remastered|bonus track|deluxe|radio edit|clean|single version|anniversary|expanded|live).*(\)|\])/i, '')
            .replace(/['’]/g, "'")
            .replace(/["”]/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanArtist(artist) {
        if (!artist) return '';
        return artist.split(/[,&\/]/)[0].trim();
    }

    // Robust LRC parser supporting [mm:ss.xx], [mm:ss.xxx], [mm:ss], and multiple timestamps
    function parseLrc(lrcText) {
        if (!lrcText || typeof lrcText !== 'string') return null;
        const lines = lrcText.split('\n');
        const result = [];
        const tagRegex = /\[(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/g;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const matches = [...trimmed.matchAll(tagRegex)];
            if (matches.length === 0) continue;

            const text = trimmed.replace(tagRegex, '').trim() || '♪';

            for (const match of matches) {
                const min = parseInt(match[1], 10);
                const sec = parseFloat(match[2]);
                const time = min * 60 + sec;
                result.push({ time, text });
            }
        }

        result.sort((a, b) => a.time - b.time);
        return result.length > 0 ? result : null;
    }

    // ==========================================
    // 3. LYRICS PROVIDERS (SYNCED ONLY)
    // ==========================================

    // Provider 1: Spotify Native Synced Lyrics
    async function fetchSpotifyLyrics(trackUri) {
        if (!trackUri) return null;
        const trackId = trackUri.split(':')[2];
        if (!trackId) return null;

        const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`;
        let data = null;

        // Try Spicetify CosmosAsync
        if (window.Spicetify?.CosmosAsync?.get) {
            try {
                data = await Spicetify.CosmosAsync.get(url);
            } catch (e) {
                // CosmosAsync fetch failed
            }
        }

        // Direct fetch fallback using platform access token
        if (!data?.lyrics && window.Spicetify?.Platform?.AuthorizationAPI?.getAccessToken) {
            try {
                const token = await Spicetify.Platform.AuthorizationAPI.getAccessToken();
                if (token) {
                    const res = await fetch(url, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'app-platform': 'WebPlayer'
                        }
                    });
                    if (res.ok) {
                        data = await res.json();
                    }
                }
            } catch (e) {
                // Direct fetch fallback failed
            }
        }

        if (!data?.lyrics?.lines) return null;

        // Strict verification: only accept synced lyrics (no unsynced)
        const syncType = data.lyrics.syncType;
        if (syncType !== 'LINE_SYNCED' && syncType !== 'SYLLABLE_SYNCED') {
            return null;
        }

        const lines = [];
        for (const line of data.lyrics.lines) {
            const timeMs = parseInt(line.startTimeMs, 10);
            if (isNaN(timeMs)) continue;
            lines.push({
                time: timeMs / 1000,
                text: (line.words || '').trim() || '♪'
            });
        }

        return lines.length > 0 ? lines : null;
    }

    // Provider 2: LRCLIB Synced Lyrics (with duration & explicit/clean validation)
    async function fetchLrclibLyrics(trackInfo, signal) {
        const { title, artist, album, duration, isExplicit } = trackInfo;
        if (!title || !artist) return null;

        const headers = {
            'x-user-agent': 'SpicetifySidebarLyrics/2.0 (https://github.com/spicetify)'
        };

        async function tryGet(params) {
            try {
                const query = Object.entries(params)
                    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
                    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
                    .join('&');
                const res = await fetch(`https://lrclib.net/api/get?${query}`, { headers, signal });
                if (!res.ok) return null;
                return await res.json();
            } catch (e) {
                return null;
            }
        }

        function validateCandidate(item) {
            if (!item || !item.syncedLyrics || typeof item.syncedLyrics !== 'string') return null;
            const trimmed = item.syncedLyrics.trim();
            if (!trimmed) return null;

            // Strict duration check: prevent out-of-time edits (radio cuts, live versions, etc.)
            if (duration > 0 && item.duration) {
                const diff = Math.abs(item.duration - duration);
                if (diff > 4) {
                    return null;
                }
            }

            // Explicit/Censored check: prevent grabbing clean/censored lyrics when explicit is playing
            const itemName = `${item.trackName || item.name || ''} ${item.albumName || ''}`.toLowerCase();
            if (isExplicit) {
                if (itemName.includes('clean') || itemName.includes('radio edit') || itemName.includes('censored')) {
                    return null;
                }
            }

            return parseLrc(trimmed);
        }

        const cleanedT = cleanTitle(title);
        const cleanedA = cleanArtist(artist);

        // 1. Exact get with duration and album
        let data = await tryGet({
            track_name: title,
            artist_name: artist,
            album_name: album,
            duration: duration > 0 ? duration : undefined
        });
        let parsed = validateCandidate(data);
        if (parsed) return parsed;
        if (signal?.aborted) return null;

        // 2. Cleaned title & artist get with duration
        if (cleanedT !== title || cleanedA !== artist || album) {
            data = await tryGet({
                track_name: cleanedT,
                artist_name: cleanedA,
                duration: duration > 0 ? duration : undefined
            });
            parsed = validateCandidate(data);
            if (parsed) return parsed;
        }
        if (signal?.aborted) return null;

        // 3. Search fallback with strict filtering & duration ranking
        try {
            const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanedT)}&artist_name=${encodeURIComponent(cleanedA)}`;
            const res = await fetch(searchUrl, { headers, signal });
            if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list) && list.length > 0) {
                    const candidates = list.filter(item => item.syncedLyrics && item.syncedLyrics.trim().length > 0);

                    // Rank candidates by duration proximity & explicit preference
                    candidates.sort((a, b) => {
                        const durDiffA = duration > 0 && a.duration ? Math.abs(a.duration - duration) : 999;
                        const durDiffB = duration > 0 && b.duration ? Math.abs(b.duration - duration) : 999;

                        const nameA = `${a.trackName || a.name || ''} ${a.albumName || ''}`.toLowerCase();
                        const nameB = `${b.trackName || b.name || ''} ${b.albumName || ''}`.toLowerCase();

                        if (isExplicit) {
                            const cleanA = nameA.includes('clean') || nameA.includes('radio edit') || nameA.includes('censored');
                            const cleanB = nameB.includes('clean') || nameB.includes('radio edit') || nameB.includes('censored');
                            if (cleanA && !cleanB) return 1;
                            if (!cleanA && cleanB) return -1;
                        }

                        return durDiffA - durDiffB;
                    });

                    for (const candidate of candidates) {
                        parsed = validateCandidate(candidate);
                        if (parsed) return parsed;
                    }
                }
            }
        } catch (e) {
            // Search request error
        }

        return null;
    }

    // Unified lyrics resolver: Spotify -> LRCLIB
    async function fetchLyricsPipeline(trackInfo, signal) {
        if (!trackInfo?.uri) return null;

        if (lyricsCache.has(trackInfo.uri)) {
            return lyricsCache.get(trackInfo.uri);
        }

        // 1. Spotify's own synced lyrics (Exact track match, 100% in-time & un-censored)
        try {
            const spotifyLines = await fetchSpotifyLyrics(trackInfo.uri);
            if (spotifyLines && spotifyLines.length > 0) {
                const res = { lines: spotifyLines, source: 'Spotify' };
                lyricsCache.set(trackInfo.uri, res);
                return res;
            }
        } catch (e) {
            // Spotify provider error
        }

        if (signal?.aborted) return null;

        // 2. LRCLIB synced lyrics fallback
        try {
            const lrclibLines = await fetchLrclibLyrics(trackInfo, signal);
            if (lrclibLines && lrclibLines.length > 0) {
                const res = { lines: lrclibLines, source: 'LRCLIB' };
                lyricsCache.set(trackInfo.uri, res);
                return res;
            }
        } catch (e) {
            // LRCLIB provider error
        }

        // Cache not-found result to prevent duplicate network spam
        lyricsCache.set(trackInfo.uri, null);
        return null;
    }

    // ==========================================
    // 4. SMART QUEUE PREFETCHING
    // ==========================================
    async function prefetchNextLyrics() {
        try {
            const queue = Spicetify.Queue;
            if (!queue) return;
            const nextTracks = queue.nextTracks || queue.next_tracks;
            if (!nextTracks || nextTracks.length === 0) return;

            const nextItem = nextTracks[0];
            const uri = nextItem.contextTrack?.uri || nextItem.uri;
            if (!uri || lyricsCache.has(uri)) return;

            const artist = nextItem.contextTrack?.metadata?.artist_name ||
                           nextItem.artist?.name ||
                           nextItem.artists?.[0]?.name;
            const title = nextItem.contextTrack?.metadata?.title ||
                          nextItem.name ||
                          nextItem.title;
            const album = nextItem.contextTrack?.metadata?.album_title ||
                          nextItem.album?.name || '';
            const durationMs = parseInt(nextItem.contextTrack?.metadata?.duration || nextItem.duration || '0', 10);
            const duration = durationMs > 0 ? Math.round(durationMs / 1000) : 0;
            const isExplicit = nextItem.contextTrack?.metadata?.is_explicit === 'true' || nextItem.isExplicit === true;

            if (artist && title) {
                await fetchLyricsPipeline({
                    uri,
                    artist,
                    title,
                    album,
                    duration,
                    isExplicit
                });
            }
        } catch (e) {
            // Ignore queue prefetch errors silently
        }
    }

    // ==========================================
    // 5. DOM INJECTION & RENDER
    // ==========================================
    function stopLyricsSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }

    function injectLyricsContainer() {
        const sidebar = document.querySelector('aside[data-testid="now-playing-panel"]') ||
                        document.querySelector('.main-nowPlayingView-container') ||
                        document.querySelector('aside');
        if (!sidebar) {
            stopLyricsSync();
            return false;
        }

        const panelContainer = sidebar.querySelector('.main-nowPlayingView-panel');
        if (!panelContainer) {
            stopLyricsSync();
            return false;
        }

        let lyricsDiv = document.getElementById('custom-sidebar-lyrics');
        if (lyricsDiv) {
            const firstSection = Array.from(panelContainer.children).find(child => child.id !== 'custom-sidebar-lyrics');
            if (firstSection && lyricsDiv.previousElementSibling !== firstSection) {
                firstSection.after(lyricsDiv);
            }
            return true;
        }

        // Container with smooth top/bottom mask fade
        lyricsDiv = document.createElement('div');
        lyricsDiv.id = 'custom-sidebar-lyrics';
        lyricsDiv.className = 'main-nowPlayingView-section';
        lyricsDiv.style.overflow = 'hidden';
        lyricsDiv.style.position = 'relative';
        lyricsDiv.style.backgroundColor = 'transparent';
        lyricsDiv.style.fontFamily = 'spotify-circular, sans-serif';
        lyricsDiv.style.margin = '-4px 0 4px 0';
        lyricsDiv.style.padding = '0';
        lyricsDiv.style.display = 'block';

        // Sharp top fade & soft bottom fade
        lyricsDiv.style.webkitMaskImage = 'linear-gradient(to bottom, transparent 0px, black 6px, black 85%, transparent 100%)';
        lyricsDiv.style.maskImage = 'linear-gradient(to bottom, transparent 0px, black 6px, black 85%, transparent 100%)';

        // Inner smooth transform wrapper
        const wrapperDiv = document.createElement('div');
        wrapperDiv.id = 'custom-sidebar-lyrics-wrapper';
        wrapperDiv.style.transition = 'transform 0.45s cubic-bezier(0.2, 1, 0.3, 1)';
        wrapperDiv.style.transform = 'translate3d(0, 0px, 0)';
        lyricsDiv.appendChild(wrapperDiv);

        const firstSection = Array.from(panelContainer.children).find(child => child.id !== 'custom-sidebar-lyrics');
        if (firstSection) {
            firstSection.after(lyricsDiv);
        } else {
            panelContainer.appendChild(lyricsDiv);
        }

        return true;
    }

    async function updateSidebarLyrics() {
        const wrapper = document.getElementById('custom-sidebar-lyrics-wrapper');
        if (!wrapper) return;

        if (currentFetchController) {
            currentFetchController.abort();
        }
        currentFetchController = new AbortController();

        stopLyricsSync();
        parsedLyrics = [];
        lastActiveIndex = -1;

        const item = Spicetify.Player.data?.item;
        if (!item) {
            wrapper.textContent = '';
            return;
        }

        const uri = item.uri;
        const artist = item.metadata?.artist_name || item.artists?.[0]?.name || '';
        const title = item.metadata?.title || item.name || '';
        const album = item.metadata?.album_title || item.album?.name || '';
        const durationSec = Spicetify.Player.getDuration()
            ? Math.round(Spicetify.Player.getDuration() / 1000)
            : (item.metadata?.duration ? Math.round(parseInt(item.metadata.duration, 10) / 1000) : 0);
        const isExplicit = item.metadata?.is_explicit === 'true' || item.isExplicit === true;

        if (!title || !artist) {
            wrapper.textContent = '';
            return;
        }

        // Prefetch next track lyrics in background
        prefetchNextLyrics();

        // Check cache
        if (lyricsCache.has(uri)) {
            const cachedData = lyricsCache.get(uri);
            renderLyrics(cachedData, wrapper);
            return;
        }

        // Display loading indicator
        wrapper.textContent = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.style.cssText = 'opacity: 0.5; font-size: 15px; padding: 24px 0; font-weight: 600; text-align: center; color: #ffffff;';
        loadingDiv.textContent = 'Searching for synced lyrics...';
        wrapper.appendChild(loadingDiv);
        wrapper.style.transform = 'translate3d(0, 20px, 0)';

        try {
            const lyricsData = await fetchLyricsPipeline({
                uri,
                artist,
                title,
                album,
                duration: durationSec,
                isExplicit
            }, currentFetchController.signal);

            renderLyrics(lyricsData, wrapper);
        } catch (err) {
            if (err.name !== 'AbortError') {
                wrapper.textContent = '';
                const errDiv = document.createElement('div');
                errDiv.style.cssText = 'opacity: 0.5; font-size: 15px; padding: 24px 0; font-weight: 600; text-align: center; color: #ffffff;';
                errDiv.textContent = 'Error loading lyrics';
                wrapper.appendChild(errDiv);
            }
        }
    }

    function renderLyrics(lyricsData, wrapper) {
        if (!lyricsData || !lyricsData.lines || lyricsData.lines.length === 0) {
            wrapper.textContent = '';
            const notFoundDiv = document.createElement('div');
            notFoundDiv.style.cssText = 'opacity: 0.5; font-size: 15px; padding: 24px 0; font-weight: 600; text-align: center; color: #ffffff;';
            notFoundDiv.textContent = 'No synced lyrics available';
            wrapper.appendChild(notFoundDiv);
            return;
        }

        parsedLyrics = [];
        lastActiveIndex = -1;
        wrapper.textContent = '';

        const fragment = document.createDocumentFragment();

        lyricsData.lines.forEach((line) => {
            const p = document.createElement('p');
            p.className = 'sidebar-lyric-line';
            p.textContent = line.text;
            p.style.cssText = 'margin: 0; padding: 5px 0; font-size: 20px; font-weight: 800; line-height: 1.3; color: #ffffff; opacity: 0.25; transition: opacity 0.35s ease, transform 0.35s ease;';

            // Click to seek in Spotify player
            p.addEventListener('click', () => {
                Spicetify.Player.seek(line.time * 1000);
            });

            fragment.appendChild(p);
            parsedLyrics.push({ time: line.time, element: p });
        });

        wrapper.appendChild(fragment);
        startLyricsSync();
    }

    // ==========================================
    // 6. REAL-TIME SMOOTH SYNC ENGINE
    // ==========================================
    let updateLyricsPosition = (force = false) => {};

    function startLyricsSync() {
        stopLyricsSync();
        const wrapper = document.getElementById('custom-sidebar-lyrics-wrapper');

        updateLyricsPosition = (force = false) => {
            if (!wrapper || !wrapper.isConnected || parsedLyrics.length === 0) {
                stopLyricsSync();
                return;
            }

            const progress = Spicetify.Player.getProgress() / 1000;
            let activeIndex = -1;

            for (let i = 0; i < parsedLyrics.length; i++) {
                if (progress >= parsedLyrics[i].time) {
                    activeIndex = i;
                } else {
                    break;
                }
            }

            if (force || activeIndex !== lastActiveIndex) {
                if (lastActiveIndex !== -1 && parsedLyrics[lastActiveIndex]) {
                    const prevEl = parsedLyrics[lastActiveIndex].element;
                    prevEl.style.opacity = '0.25';
                    prevEl.style.transform = 'scale(1)';
                }

                if (activeIndex !== -1 && parsedLyrics[activeIndex]) {
                    const activeEl = parsedLyrics[activeIndex].element;
                    activeEl.style.opacity = '1.0';
                    activeEl.style.transform = 'scale(1.02)';

                    // Position active line top exactly at 0px right underneath track info header
                    const targetY = 0 - activeEl.offsetTop;
                    wrapper.style.transform = `translate3d(0, ${targetY}px, 0)`;
                } else if (activeIndex === -1) {
                    // Before first line begins
                    wrapper.style.transform = 'translate3d(0, 0px, 0)';
                }

                lastActiveIndex = activeIndex;
            }
        };

        // Run immediately to position on correct line right away
        updateLyricsPosition(true);

        syncInterval = setInterval(() => {
            updateLyricsPosition();
        }, 120);
    }

    // ==========================================
    // 7. INITIALIZATION & EVENT LISTENERS
    // ==========================================
    function initLyrics() {
        if (!Spicetify.Player || !Spicetify.Player.data) {
            setTimeout(initLyrics, 400);
            return;
        }

        // Check if sidebar container exists every 3s (e.g. after view transitions)
        setInterval(() => {
            if (!document.getElementById('custom-sidebar-lyrics')) {
                if (injectLyricsContainer()) {
                    updateSidebarLyrics();
                }
            }
        }, 3000);

        // Update lyrics on song change
        Spicetify.Player.addEventListener('songchange', () => {
            injectLyricsContainer();
            updateSidebarLyrics();
        });

        // Handle play/pause
        Spicetify.Player.addEventListener('onplaypause', () => {
            if (Spicetify.Player.isPlaying() && !syncInterval && parsedLyrics.length > 0) {
                startLyricsSync();
            } else if (typeof updateLyricsPosition === 'function') {
                updateLyricsPosition(true);
            }
        });

        // Handle seek (rewind / fast-forward)
        Spicetify.Player.addEventListener('onseek', () => {
            if (typeof updateLyricsPosition === 'function') {
                updateLyricsPosition(true);
            }
        });

        if (injectLyricsContainer()) {
            updateSidebarLyrics();
        }
    }

    initLyrics();
})();
